mod support;
use cc_session_reader::{extract_manifest, Job, Manifest};
use rusqlite::Connection;
use serde_json::{json, Value};
use support::Fixture;

#[test]
fn antigravity_missing_completion_columns_keep_all_readable_questions_incomplete() {
    for (status, busy) in [(false, false), (true, false), (false, true), (true, true)] {
        let f = Fixture::new();
        let source=f.lines("antigravity/brain/session-01/.system_generated/logs/transcript_full.jsonl",&[
            json!({"step_index":0,"type":"USER_INPUT","content":"question one"}),
            json!({"step_index":1,"type":"PLANNER_RESPONSE","status":"DONE","content":"answer one"}),
            json!({"step_index":2,"type":"USER_INPUT","content":"question two"}),
            json!({"step_index":3,"type":"PLANNER_RESPONSE","status":"DONE","content":"answer two"}),
        ]);
        let db = Connection::open(f.root.join("antigravity/conversation_summaries.db")).unwrap();
        db.execute_batch(&format!("CREATE TABLE conversation_summaries(conversation_id TEXT,workspace_uris TEXT,parent_conversation_id TEXT{}{});",
            if status {",status TEXT"} else {""},if busy {",not_fully_idle INTEGER"} else {""})).unwrap();
        let uris = json!([url::Url::from_directory_path(&f.project)
            .unwrap()
            .to_string()])
        .to_string();
        db.execute("INSERT INTO conversation_summaries(conversation_id,workspace_uris,parent_conversation_id) VALUES('session-01',?1,'')",[uris]).unwrap();
        if status {
            db.execute(
                "UPDATE conversation_summaries SET status='CASCADE_RUN_STATUS_IDLE'",
                [],
            )
            .unwrap();
        }
        if busy {
            db.execute("UPDATE conversation_summaries SET not_fully_idle=0", [])
                .unwrap();
        }
        let row = f.extract("agy", &source, "session-01");
        assert_eq!(row["status"], "parsed");
        let turns = row["turns"].as_array().unwrap();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0]["prompt_parts"], json!(["question one"]));
        assert_eq!(turns[1]["prompt_parts"], json!(["question two"]));
        for turn in turns {
            assert_eq!(
                turn["state"],
                if status && busy {
                    "complete"
                } else {
                    "incomplete"
                }
            );
            if !status || !busy {
                assert_eq!(turn["final_answer_parts"], json!([]));
            }
        }
        // Missing completion columns must never weaken project/parent authorization.
        db.execute(
            "UPDATE conversation_summaries SET workspace_uris='[\"file:///other-project\"]'",
            [],
        )
        .unwrap();
        std::fs::write(&source, b"\xffPRIVATE_BODY").unwrap();
        assert_eq!(
            f.extract("agy", &source, "session-01")["status"],
            "cross_project_metadata_blocked"
        );
        db.execute(
            "UPDATE conversation_summaries SET parent_conversation_id='parent'",
            [],
        )
        .unwrap();
        assert_eq!(
            f.extract("agy", &source, "session-01")["status"],
            "metadata_error"
        );
    }
}

fn sqlite_job(f: &Fixture, provider: &str, source: String, id: &str) -> Value {
    extract_manifest(&Manifest {
        authorized_root: f.project.to_str().unwrap().into(),
        jobs: vec![Job {
            provider: provider.into(),
            session_id: id.into(),
            source,
            project: f.project.to_str().unwrap().into(),
            allowed: true,
            synthetic: true,
        }],
    })
    .unwrap()
    .remove(0)
}

#[test]
fn sqlite_empty_parent_is_root_and_source_identity_is_checked_with_alternate_directory_schema() {
    let f = Fixture::new();
    let path = f.root.join("state.db");
    let db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE sessions(id TEXT,directory TEXT,parent_session_id TEXT); CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,finish_reason TEXT);").unwrap();
    db.execute(
        "INSERT INTO sessions VALUES('session-01',?1,'')",
        [f.project.to_str().unwrap()],
    )
    .unwrap();
    db.execute_batch("INSERT INTO messages VALUES(1,'session-01','user','question',NULL); INSERT INTO messages VALUES(2,'session-01','assistant','answer','stop');").unwrap();
    let source = format!("sqlite:{}#session-01", path.display());
    let row = sqlite_job(&f, "hermes", source.clone(), "session-01");
    assert_eq!(row["status"], "parsed");
    assert_eq!(row["turns"][0]["state"], "complete");
    assert_eq!(
        sqlite_job(&f, "hermes", source.clone(), "wrong")["status"],
        "metadata_error"
    );
    db.execute("UPDATE sessions SET directory='/other-project'", [])
        .unwrap();
    db.execute("DROP TABLE messages", []).unwrap();
    assert_eq!(
        sqlite_job(&f, "hermes", source, "session-01")["status"],
        "cross_project_metadata_blocked"
    );
}

#[test]
fn opencode_sqlite_empty_parent_and_source_identity_are_consistent() {
    let f = Fixture::new();
    let path = f.root.join("opencode.db");
    let db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE session(id TEXT,directory TEXT,parent_id TEXT); CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,data TEXT);").unwrap();
    db.execute(
        "INSERT INTO session VALUES('ses_01',?1,'')",
        [f.project.to_str().unwrap()],
    )
    .unwrap();
    let source = format!("sqlite:{}:ses_01", path.display());
    assert_eq!(
        sqlite_job(&f, "opencode", source.clone(), "ses_01")["status"],
        "parsed"
    );
    assert_eq!(
        sqlite_job(&f, "opencode", source.clone(), "ses_wrong")["status"],
        "metadata_error"
    );
    db.execute("UPDATE session SET parent_id='ses_parent'", [])
        .unwrap();
    assert_eq!(
        sqlite_job(&f, "opencode", source, "ses_01")["status"],
        "metadata_error"
    );
}

#[test]
fn sqlite_checks_all_present_project_and_parent_aliases() {
    let f = Fixture::new();
    let path = f.root.join("aliases.db");
    let db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE sessions(id TEXT,cwd TEXT,directory TEXT,parent_id TEXT,parent_session_id TEXT);").unwrap();
    db.execute(
        "INSERT INTO sessions VALUES('session-01',?1,'/other-project','',NULL)",
        [f.project.to_str().unwrap()],
    )
    .unwrap();
    let source = format!("sqlite:{}#session-01", path.display());
    assert_eq!(
        sqlite_job(&f, "hermes", source.clone(), "session-01")["status"],
        "cross_project_metadata_blocked"
    );
    db.execute(
        "UPDATE sessions SET directory=cwd,parent_session_id='parent'",
        [],
    )
    .unwrap();
    assert_eq!(
        sqlite_job(&f, "hermes", source, "session-01")["status"],
        "metadata_error"
    );
}
