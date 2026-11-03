use cc_session_reader::{extract_manifest,Job,Manifest};
use serde_json::json;
use std::{fs,path::PathBuf};
static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn setup()->(PathBuf,Manifest){
    let root=std::env::temp_dir().join(format!("weekly-agy-{}-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),NEXT.fetch_add(1,std::sync::atomic::Ordering::SeqCst)));
    let project=root.join("project");fs::create_dir_all(&project).unwrap();let project=project.canonicalize().unwrap();
    let base=root.join("antigravity");let source=base.join("brain/session-01/.system_generated/logs/transcript_full.jsonl");fs::create_dir_all(source.parent().unwrap()).unwrap();
    let db=rusqlite::Connection::open(base.join("conversation_summaries.db")).unwrap();
    db.execute_batch("CREATE TABLE conversation_summaries(conversation_id TEXT,workspace_uris TEXT,status TEXT,not_fully_idle INTEGER,parent_conversation_id TEXT);").unwrap();
    let uris=serde_json::to_string(&vec![url::Url::from_directory_path(&project).unwrap().to_string()]).unwrap();
    db.execute("INSERT INTO conversation_summaries VALUES('session-01',?1,'CASCADE_RUN_STATUS_IDLE',0,NULL)",[uris]).unwrap();
    let records=vec![
        json!({"step_index":0,"type":"USER_INPUT","source":"USER","status":"DONE","created_at":"2026-10-29T09:00:00Z","content":"<USER_REQUEST>真实提问</USER_REQUEST><ADDITIONAL_METADATA>不要提取</ADDITIONAL_METADATA>"}),
        json!({"step_index":1,"type":"GENERIC","source":"MODEL","status":"DONE","content":"TOOL_OUTPUT_MUST_NOT_BE_FINAL"}),
        json!({"step_index":2,"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","content":"中间说明"}),
        json!({"step_index":3,"type":"GENERIC","source":"MODEL","status":"DONE","content":"INTERNAL_STEPS_MUST_NOT_BE_FINAL"}),
        json!({"step_index":4,"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","content":"正式回复"}),
    ];
    fs::write(&source,records.iter().map(|r|serde_json::to_string(r).unwrap()+"\n").collect::<String>()).unwrap();
    let manifest=Manifest{authorized_root:project.to_string_lossy().into(),jobs:vec![Job{provider:"agy".into(),session_id:"session-01".into(),source:source.to_string_lossy().into(),project:project.to_string_lossy().into(),allowed:true,synthetic:true}]};
    (root,manifest)
}
#[test]
fn final_is_last_completed_planner_response_not_generic_model_record(){
    let (root,manifest)=setup();let result=extract_manifest(&manifest).unwrap();
    assert_eq!(result[0]["status"],"parsed");assert_eq!(result[0]["turns"][0]["prompt_parts"],json!(["真实提问"]));assert_eq!(result[0]["turns"][0]["final_answer_parts"],json!(["正式回复"]));assert_eq!(result[0]["turns"][0]["state"],"complete");
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn active_or_cross_project_conversation_is_not_accepted_as_complete(){
    let (root,manifest)=setup();
    let db=rusqlite::Connection::open(root.join("antigravity/conversation_summaries.db")).unwrap();
    db.execute("UPDATE conversation_summaries SET not_fully_idle=1",[]).unwrap();
    let result=extract_manifest(&manifest).unwrap();assert_eq!(result[0]["turns"][0]["state"],"incomplete");
    db.execute("UPDATE conversation_summaries SET workspace_uris='[\"file:///not-allowed\"]'",[]).unwrap();
    let result=extract_manifest(&manifest).unwrap();assert_eq!(result[0]["status"],"cross_project_metadata_blocked");
    fs::remove_dir_all(root).unwrap();
}
