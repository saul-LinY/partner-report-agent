use cc_session_reader::{extract_manifest, Job, Manifest};
use serde_json::{json,Value};
use std::{fs,path::PathBuf};
static NEXT:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(0);

fn lines(path:PathBuf,rows:&[Value]) {
    fs::write(path,rows.iter().map(|v|v.to_string()+"\n").collect::<String>()).unwrap();
}
fn fixture()->(PathBuf,Manifest){
    let root=std::env::temp_dir().join(format!("weekly-grok-{}-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),NEXT.fetch_add(1,std::sync::atomic::Ordering::SeqCst)));
    let project=root.join("project");fs::create_dir_all(&project).unwrap();let project=project.canonicalize().unwrap();
    let folder=root.join("sessions/encoded/session-01");fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("summary.json"),json!({"info":{"id":"session-01","cwd":project},"generated_title":"原生 Grok 标题"}).to_string()).unwrap();
    lines(folder.join("chat_history.jsonl"),&[
        json!({"type":"system","content":"SYSTEM_MUST_NOT_UPLOAD"}),
        json!({"type":"user","content":[{"type":"text","text":"<user_info>ENVIRONMENT_MUST_NOT_UPLOAD</user_info>"}]}),
        json!({"type":"user","synthetic_reason":"system_reminder","content":"REMINDER_MUST_NOT_UPLOAD"}),
        json!({"type":"user","prompt_index":0,"content":[{"type":"text","text":"<user_query>真实提问</user_query>"}]}),
        json!({"type":"reasoning","summary":"THINKING_MUST_NOT_UPLOAD"}),
        json!({"type":"assistant","model_id":"grok-test","content":"中间说明","tool_calls":[{"id":"call-01","name":"read_file","arguments":"{}"}]}),
        json!({"type":"tool_result","tool_call_id":"call-01","content":"TOOL_OUTPUT_MUST_NOT_UPLOAD"}),
        json!({"type":"assistant","model_id":"grok-test","content":"**正式回复**"}),
    ]);
    lines(folder.join("events.jsonl"),&[
        json!({"type":"turn_started","session_id":"session-01","turn_number":0}),
        json!({"type":"turn_ended","outcome":"completed"}),
    ]);
    let manifest=Manifest{authorized_root:project.to_string_lossy().into(),jobs:vec![Job{provider:"grokbuild".into(),session_id:"session-01".into(),source:folder.join("summary.json").to_string_lossy().into(),project:project.to_string_lossy().into(),allowed:true,synthetic:true}]};
    (root,manifest)
}
#[test]
fn native_grok_filters_injections_and_tool_result_preserves_title_free_reply(){
    let(root,manifest)=fixture();let result=extract_manifest(&manifest).unwrap();let row=&result[0];
    assert_eq!(row["status"],"parsed");assert_eq!(row["turns"].as_array().unwrap().len(),1);
    let turn=&row["turns"][0];assert_eq!(turn["turn_id"],"prompt-0");assert_eq!(turn["prompt_parts"],json!(["真实提问"]));assert_eq!(turn["final_answer_parts"],json!(["**正式回复**"]));assert_eq!(turn["state"],"complete");assert_eq!(turn["evidence"],"native_turn_completed");assert_eq!(turn["model"],"grok-test");assert_eq!(row["blocks"]["tool_call"],1);assert_eq!(row["blocks"]["tool_result"],1);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn active_retry_invalidates_old_completed_marker_and_keeps_turn_identity(){
    let(root,manifest)=fixture();let before=extract_manifest(&manifest).unwrap();
    let folder=PathBuf::from(&manifest.jobs[0].source).parent().unwrap().to_path_buf();
    lines(folder.join("events.jsonl"),&[
        json!({"type":"turn_started","session_id":"session-01","turn_number":0}),json!({"type":"turn_ended","outcome":"completed"}),json!({"type":"turn_started","session_id":"session-01","turn_number":0})
    ]);
    let active=extract_manifest(&manifest).unwrap();assert_eq!(active[0]["turns"][0]["state"],"incomplete");assert_eq!(active[0]["turns"][0]["turn_id"],before[0]["turns"][0]["turn_id"]);assert_eq!(active[0]["turns"][0]["final_answer_parts"],json!([]));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn wrong_project_or_identity_is_rejected_before_transcript_read(){
    let(root,mut manifest)=fixture();let folder=PathBuf::from(&manifest.jobs[0].source).parent().unwrap().to_path_buf();fs::remove_file(folder.join("chat_history.jsonl")).unwrap();
    fs::write(folder.join("summary.json"),json!({"info":{"id":"session-01","cwd":"/unapproved-project"}}).to_string()).unwrap();
    let result=extract_manifest(&manifest).unwrap();assert_eq!(result[0]["status"],"cross_project_metadata_blocked");
    manifest.jobs[0].session_id="another-id".into();let result=extract_manifest(&manifest).unwrap();assert_eq!(result[0]["status"],"metadata_error");
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn assistant_text_followed_by_tool_call_is_not_final(){
    let(root,manifest)=fixture();let folder=PathBuf::from(&manifest.jobs[0].source).parent().unwrap().to_path_buf();
    let mut content=fs::read_to_string(folder.join("chat_history.jsonl")).unwrap();content.push_str(&(json!({"type":"assistant","content":"继续处理","tool_calls":[{"id":"next","name":"read_file","arguments":"{}"}]}).to_string()+"\n"));fs::write(folder.join("chat_history.jsonl"),content).unwrap();
    let result=extract_manifest(&manifest).unwrap();assert_eq!(result[0]["turns"][0]["state"],"incomplete");
    fs::remove_dir_all(root).unwrap();
}
