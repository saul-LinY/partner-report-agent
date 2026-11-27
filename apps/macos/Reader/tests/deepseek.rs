use cc_session_reader::{extract_manifest, Job, Manifest};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};
static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const ID: &str = "session-0f0f0f0f-0000-4000-8000-000000000001";

fn write_session(path: &PathBuf, rows: &[Value]) {
    let text: String = rows.iter().map(|v| v.to_string() + "\n").collect();
    fs::write(path, zstd::encode_all(text.as_bytes(), 3).unwrap()).unwrap();
}

fn header(cwd: &PathBuf, depth: u64) -> Value {
    json!({"type":"session","id":ID,"cwd":cwd,"version":4,"delegationDepth":depth,"isSeeded":false,"agentPreset":"standard","createdAt":1_000})
}
fn record(kind: &str, seq: u64, data: Value) -> Value {
    json!({"type":kind,"seq":seq,"time":1_000 + seq,"data":data})
}
fn user(seq: u64, source_kind: &str, text: &str) -> Value {
    record("user/message", seq, json!({"id":format!("u{seq}"),"role":"user","source":{"kind":source_kind},"content":[{"type":"text","text":text}]}))
}
fn assistant(seq: u64, turn: u64, step: u64, content: Value) -> Value {
    record("assistant/message", seq, json!({"turn":turn,"step":step,"message":{"id":format!("a{seq}"),"role":"assistant","source":{"kind":"model","model":"test-model"},"content":content}}))
}
fn turn_start(seq: u64, turn: u64) -> Value { record("turn/start", seq, json!({"turn":turn})) }
fn turn_end(seq: u64, turn: u64, reason: &str) -> Value { record("turn/end", seq, json!({"turn":turn,"reason":{"kind":reason}})) }

fn fixture() -> (PathBuf, PathBuf, Manifest) {
    let root = std::env::temp_dir().join(format!("weekly-deepseek-{}-{}", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    let project = root.join("project");
    fs::create_dir_all(&project).unwrap();
    let project = project.canonicalize().unwrap();
    let folder = root.join("sessions/--project--").join(ID);
    fs::create_dir_all(&folder).unwrap();
    let file = folder.join("session.v4.jsonl.zstd");
    write_session(&file, &[
        header(&project, 0),
        turn_start(1, 1),
        user(2, "runtime-context", "RUNTIME_MUST_NOT_UPLOAD"),
        user(3, "skill-catalog", "CATALOG_MUST_NOT_UPLOAD"),
        user(4, "user", "真实提问"),
        assistant(5, 1, 1, json!([
            {"type":"reasoning","text":"THINKING_MUST_NOT_UPLOAD"},
            {"type":"text","text":"中间说明"},
            {"type":"tool-call","id":"call-1","name":"read_file","arguments":{"path":"a.txt"}}
        ])),
        record("tool/result", 6, json!({"turn":1,"step":1,"message":{"content":"TOOL_OUTPUT_MUST_NOT_UPLOAD"}})),
        assistant(7, 1, 2, json!([{"type":"reasoning","text":"THINKING_MUST_NOT_UPLOAD"},{"type":"text","text":"**正式回复**"}])),
        turn_end(8, 1, "completed"),
    ]);
    let manifest = Manifest {
        authorized_root: project.to_string_lossy().into(),
        jobs: vec![Job { provider: "deepseek".into(), session_id: ID.into(), source: file.to_string_lossy().into(), project: project.to_string_lossy().into(), allowed: true, synthetic: true }],
    };
    (root, file, manifest)
}

#[test]
fn reads_prompt_and_final_reply_only_and_never_injected_context_thinking_or_tool_output() {
    let (root, _, manifest) = fixture();
    let result = extract_manifest(&manifest).unwrap();
    let row = &result[0];
    assert_eq!(row["status"], "parsed");
    assert_eq!(row["turns"].as_array().unwrap().len(), 1);
    let turn = &row["turns"][0];
    assert_eq!(turn["prompt_parts"], json!(["真实提问"]));
    assert_eq!(turn["final_answer_parts"], json!(["**正式回复**"]));
    assert_eq!(turn["state"], "complete");
    assert_eq!(turn["evidence"], "native_turn_completed");
    assert_eq!(turn["model"], "test-model");
    let everything = serde_json::to_string(&result).unwrap();
    for secret in ["RUNTIME_MUST_NOT_UPLOAD", "CATALOG_MUST_NOT_UPLOAD", "THINKING_MUST_NOT_UPLOAD", "TOOL_OUTPUT_MUST_NOT_UPLOAD", "中间说明"] {
        assert!(!everything.contains(secret), "{secret} reached the output");
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_turn_that_is_still_running_or_was_interrupted_has_no_final_reply() {
    let (root, file, manifest) = fixture();
    let project = PathBuf::from(&manifest.authorized_root);
    // Still running: no turn/end yet.
    write_session(&file, &[header(&project, 0), turn_start(1, 1), user(2, "user", "进行中的提问"), assistant(3, 1, 1, json!([{"type":"text","text":"写到一半"}]))]);
    let running = extract_manifest(&manifest).unwrap();
    assert_eq!(running[0]["turns"][0]["state"], "incomplete");
    assert_eq!(running[0]["turns"][0]["final_answer_parts"], json!([]));
    // Ended, but not as completed.
    write_session(&file, &[header(&project, 0), turn_start(1, 1), user(2, "user", "被打断的提问"), assistant(3, 1, 1, json!([{"type":"text","text":"没说完"}])), turn_end(4, 1, "interrupted")]);
    let interrupted = extract_manifest(&manifest).unwrap();
    assert_eq!(interrupted[0]["turns"][0]["state"], "incomplete");
    // A completed turn that is resumed is not complete again until it ends again.
    write_session(&file, &[header(&project, 0), turn_start(1, 1), user(2, "user", "继续的提问"), assistant(3, 1, 1, json!([{"type":"text","text":"第一次回复"}])), turn_end(4, 1, "completed"), turn_start(5, 1)]);
    let resumed = extract_manifest(&manifest).unwrap();
    assert_eq!(resumed[0]["turns"][0]["state"], "incomplete");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn text_before_a_tool_call_is_not_the_final_reply() {
    let (root, file, manifest) = fixture();
    let project = PathBuf::from(&manifest.authorized_root);
    write_session(&file, &[
        header(&project, 0), turn_start(1, 1), user(2, "user", "提问"),
        assistant(3, 1, 1, json!([{"type":"text","text":"我先查一下"},{"type":"tool-call","id":"c1","name":"search","arguments":{}}])),
        turn_end(4, 1, "completed"),
    ]);
    let result = extract_manifest(&manifest).unwrap();
    assert_eq!(result[0]["turns"][0]["final_answer_parts"], json!([]));
    assert_eq!(result[0]["turns"][0]["state"], "incomplete");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn several_turns_keep_their_own_prompts_and_replies() {
    let (root, file, manifest) = fixture();
    let project = PathBuf::from(&manifest.authorized_root);
    write_session(&file, &[
        header(&project, 0),
        turn_start(1, 1), user(2, "runtime-context", "CONTEXT"), user(3, "user", "第一问"), assistant(4, 1, 1, json!([{"type":"text","text":"第一答"}])), turn_end(5, 1, "completed"),
        turn_start(6, 2), user(7, "user", "第二问"), assistant(8, 2, 1, json!([{"type":"text","text":"第二答"}])), turn_end(9, 2, "completed"),
    ]);
    let result = extract_manifest(&manifest).unwrap();
    let turns = result[0]["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0]["prompt_parts"], json!(["第一问"]));
    assert_eq!(turns[0]["final_answer_parts"], json!(["第一答"]));
    assert_eq!(turns[1]["prompt_parts"], json!(["第二问"]));
    assert_eq!(turns[1]["final_answer_parts"], json!(["第二答"]));
    assert_ne!(turns[0]["turn_id"], turns[1]["turn_id"]);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn another_project_a_wrong_identity_and_sub_agent_sessions_are_rejected_before_any_message_is_read() {
    let (root, file, mut manifest) = fixture();
    let project = PathBuf::from(&manifest.authorized_root);
    // The session belongs to a project the member has not allowed.
    write_session(&file, &[header(&PathBuf::from("/unapproved-project"), 0), turn_start(1, 1), user(2, "user", "PRIVATE_MUST_NOT_UPLOAD")]);
    let other = extract_manifest(&manifest).unwrap();
    assert_eq!(other[0]["status"], "cross_project_metadata_blocked");
    assert!(!serde_json::to_string(&other).unwrap().contains("PRIVATE_MUST_NOT_UPLOAD"));
    // A session a delegated sub-agent opened is not the member's own session.
    write_session(&file, &[header(&project, 1), turn_start(1, 1), user(2, "user", "SUBAGENT_MUST_NOT_UPLOAD")]);
    let child = extract_manifest(&manifest).unwrap();
    assert_eq!(child[0]["status"], "metadata_error");
    assert!(!serde_json::to_string(&child).unwrap().contains("SUBAGENT_MUST_NOT_UPLOAD"));
    // The header id must be the one the job asked for.
    write_session(&file, &[header(&project, 0), turn_start(1, 1), user(2, "user", "提问")]);
    manifest.jobs[0].session_id = "session-someone-else".into();
    let wrong = extract_manifest(&manifest).unwrap();
    assert_eq!(wrong[0]["status"], "metadata_error");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_file_that_is_not_a_session_log_is_not_read_at_all() {
    let (root, file, mut manifest) = fixture();
    let renamed = file.with_file_name("notes.jsonl.zstd");
    fs::copy(&file, &renamed).unwrap();
    manifest.jobs[0].source = renamed.to_string_lossy().into();
    let result = extract_manifest(&manifest).unwrap();
    assert_eq!(result[0]["status"], "metadata_error");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_half_written_last_frame_keeps_the_records_before_it() {
    let (root, file, manifest) = fixture();
    let project = PathBuf::from(&manifest.authorized_root);
    // The harness appends one zstd frame at a time; a live writer can leave the last one half written.
    let frame = |rows: &[Value]| zstd::encode_all(rows.iter().map(|v| v.to_string() + "\n").collect::<String>().as_bytes(), 3).unwrap();
    let mut bytes = frame(&[header(&project, 0), turn_start(1, 1), user(2, "user", "真实提问")]);
    bytes.extend(&frame(&[assistant(3, 1, 1, json!([{"type":"text","text":"回复"}])), turn_end(4, 1, "completed")]));
    let cut = bytes.len() - 6;
    fs::write(&file, &bytes[..cut]).unwrap();
    let result = extract_manifest(&manifest).unwrap();
    assert_eq!(result[0]["status"], "parsed");
    assert_eq!(result[0]["turns"][0]["prompt_parts"], json!(["真实提问"]));
    assert_eq!(result[0]["turns"][0]["state"], "incomplete");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_root_session_with_a_null_delegation_depth_is_read() {
    let (root, file, manifest) = fixture();
    let project = PathBuf::from(&manifest.authorized_root);
    let mut head = header(&project, 0);
    head["delegationDepth"] = Value::Null;
    write_session(&file, &[head, turn_start(1, 1), user(2, "user", "提问"), assistant(3, 1, 1, json!([{"type":"text","text":"回复"}])), turn_end(4, 1, "completed")]);
    let result = extract_manifest(&manifest).unwrap();
    assert_eq!(result[0]["status"], "parsed");
    assert_eq!(result[0]["turns"][0]["state"], "complete");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_prompt_written_before_its_turn_starts_stays_with_its_reply() {
    let (root, file, manifest) = fixture();
    let project = PathBuf::from(&manifest.authorized_root);
    let prompt = record("user/message", 1, json!({"turn":1,"role":"user","source":{"kind":"user"},"content":[{"type":"text","text":"提问"}]}));
    write_session(&file, &[header(&project, 0), prompt, turn_start(2, 1), assistant(3, 1, 1, json!([{"type":"text","text":"回复"}])), turn_end(4, 1, "completed")]);
    let result = extract_manifest(&manifest).unwrap();
    let turns = result[0]["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0]["prompt_parts"], json!(["提问"]));
    assert_eq!(turns[0]["final_answer_parts"], json!(["回复"]));
    assert_eq!(turns[0]["state"], "complete");
    fs::remove_dir_all(root).unwrap();
}
