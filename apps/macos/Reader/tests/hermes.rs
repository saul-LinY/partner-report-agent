use cc_session_reader::{extract_manifest, Job, Manifest};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, sync::atomic::{AtomicU64, Ordering}};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture { root: PathBuf, db: Connection, manifest: Manifest }
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("weekly-hermes-{}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(), NEXT.fetch_add(1, Ordering::SeqCst)));
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        let project = project.canonicalize().unwrap().to_string_lossy().into_owned();
        let path = root.join("state.db");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE sessions(id TEXT,cwd TEXT,parent_session_id TEXT,model TEXT,ended_at REAL); CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL,tool_calls TEXT,tool_call_id TEXT,reasoning TEXT,finish_reason TEXT,active INTEGER,compacted INTEGER,display_metadata TEXT);").unwrap();
        db.execute("INSERT INTO sessions VALUES('session-01',?1,NULL,'native-model',NULL)", [&project]).unwrap();
        let manifest = Manifest { authorized_root: project.clone(), jobs: vec![Job { provider: "hermes".into(), session_id: "session-01".into(), source: format!("sqlite:{}#session-01", path.display()), project, allowed: true, synthetic: true }] };
        Self { root, db, manifest }
    }
    fn add(&self, id: i64, role: &str, content: &str, finish: Option<&str>, calls: Option<&str>) {
        self.db.execute("INSERT INTO messages(id,session_id,role,content,timestamp,tool_calls,finish_reason,active,compacted) VALUES(?1,'session-01',?2,?3,?4,?5,?6,1,0)", params![id,role,content,1793273127.0+id as f64,calls,finish]).unwrap();
    }
    fn result(&self) -> Value { extract_manifest(&self.manifest).unwrap().remove(0) }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); } }

#[test]
fn native_finish_reason_completes_reply_while_cli_session_remains_open() {
    let f = Fixture::new();
    f.add(1,"system","SYSTEM_MUST_NOT_UPLOAD",None,None);
    f.add(2,"user","test",None,None);
    f.add(3,"assistant","Ready. What would you like me to test?",Some("stop"),None);
    f.db.execute("UPDATE messages SET reasoning='THINKING_MUST_NOT_UPLOAD' WHERE id=3",[]).unwrap();
    let result = f.result(); let turn = &result["turns"][0];
    assert_eq!(result["status"],"parsed");
    assert_eq!(turn["prompt_parts"],json!(["test"]));
    assert_eq!(turn["final_answer_parts"],json!(["Ready. What would you like me to test?"]));
    assert_eq!(turn["state"],"complete");
    assert_eq!(turn["evidence"],"native_stop_reason");
    assert_eq!(turn["model"],"native-model");
    assert_eq!(turn["turn_id"],"2");
    assert!(turn["answer_ts"].as_i64().unwrap()>0);
}

#[test]
fn missing_truncated_or_tool_finish_is_not_a_final_answer() {
    let f = Fixture::new(); f.add(1,"user","question",None,None); f.add(2,"assistant","partial",None,None);
    for reason in [None,Some("length"),Some("tool_calls"),Some("error"),Some("content_filter")] {
        f.db.execute("UPDATE messages SET finish_reason=?1 WHERE id=2",params![reason]).unwrap();
        let result=f.result(); assert_eq!(result["turns"][0]["state"],"incomplete"); assert_eq!(result["turns"][0]["final_answer_parts"],json!([]));
    }
}

#[test]
fn tool_activity_invalidates_prior_text_until_a_new_terminal_reply() {
    let f = Fixture::new(); f.add(1,"user","question",None,None); f.add(2,"assistant","earlier",Some("stop"),None);
    let id = f.result()["turns"][0]["turn_id"].clone();
    f.add(3,"assistant","checking",Some("stop"),Some(r#"[{"name":"read_file","arguments":"{}"}]"#));
    f.add(4,"tool","TOOL_MUST_NOT_UPLOAD",None,None);
    assert_eq!(f.result()["turns"][0]["state"],"incomplete");
    f.add(5,"assistant","final after tool",Some("stop"),None);
    let result=f.result(); assert_eq!(result["turns"][0]["turn_id"],id);
    assert_eq!(result["turns"][0]["final_answer_parts"],json!(["final after tool"]));
}

#[test]
fn rewound_and_model_only_rows_do_not_complete_a_visible_turn() {
    let f=Fixture::new(); f.add(1,"user","question",None,None);
    f.add(2,"assistant","REWOUND_MUST_NOT_UPLOAD",Some("stop"),None);
    f.db.execute("UPDATE messages SET active=0 WHERE id=2",[]).unwrap();
    f.add(3,"assistant","MODEL_ONLY_MUST_NOT_UPLOAD",Some("stop"),None);
    f.db.execute("UPDATE messages SET display_metadata=?1 WHERE id=3",[json!({"model_only":true}).to_string()]).unwrap();
    assert_eq!(f.result()["turns"][0]["state"],"incomplete");
    f.add(4,"assistant","visible final",Some("stop"),None);
    f.db.execute("UPDATE messages SET active=0,compacted=1 WHERE id=4",[]).unwrap();
    f.add(5,"assistant","visible final",Some("stop"),None);
    f.db.execute("UPDATE messages SET timestamp=(SELECT timestamp FROM messages WHERE id=4) WHERE id=5",[]).unwrap();
    let result=f.result(); assert_eq!(result["turns"].as_array().unwrap().len(),1);
    assert_eq!(result["turns"][0]["final_answer_parts"],json!(["visible final"]));
}

#[test]
fn legacy_database_without_finish_reason_keeps_reply_unconfirmed() {
    let f=Fixture::new(); f.add(1,"user","question",None,None); f.add(2,"assistant","legacy",Some("stop"),None);
    f.db.execute("ALTER TABLE messages DROP COLUMN finish_reason",[]).unwrap();
    let result=f.result(); assert_eq!(result["status"],"parsed"); assert_eq!(result["turns"][0]["state"],"incomplete");
}

#[test]
fn authorization_and_parent_checks_happen_before_reading_messages() {
    let mut f=Fixture::new(); f.db.execute("DROP TABLE messages",[]).unwrap();
    f.manifest.jobs[0].allowed=false;
    assert_eq!(f.result()["status"],"blocked_before_open");
    f.manifest.jobs[0].allowed=true;
    f.db.execute("UPDATE sessions SET cwd='/unapproved'",[]).unwrap();
    assert_eq!(f.result()["status"],"cross_project_metadata_blocked");
    f.db.execute("UPDATE sessions SET parent_session_id='parent'",[]).unwrap();
    assert_eq!(f.result()["status"],"metadata_error");
}
