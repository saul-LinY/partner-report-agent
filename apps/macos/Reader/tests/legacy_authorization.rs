mod support;
use serde_json::json;
use std::{fs, path::PathBuf};
use support::Fixture;

fn hermes(f: &Fixture, name: &str, nested: bool, finish: Option<&str>) -> PathBuf {
    let user = json!({"id":1,"role":"user","content":"question"});
    let mut answer = json!({"id":2,"role":"assistant","content":"answer"});
    if let Some(finish) = finish {
        answer["finish_reason"] = json!(finish);
    }
    let rows = if nested {
        vec![
            json!({"type":"init","sessionId":"hermes-01","directory":f.project,"parent_session_id":""}),
            json!({"type":"message","message":user}),
            json!({"type":"message","message":answer}),
        ]
    } else {
        vec![
            json!({"type":"session","id":"hermes-01","cwd":f.project}),
            user,
            answer,
        ]
    };
    f.lines(name, &rows)
}

#[test]
fn hermes_jsonl_and_json_extension_discover_and_extract_flat_and_nested_messages() {
    let f = Fixture::new();
    for (name, nested) in [("flat.jsonl", false), ("nested.json", true)] {
        let source = hermes(&f, name, nested, Some("stop"));
        let row = f.discover_then_extract("hermes", &source);
        assert_eq!(row["status"], "parsed");
        assert_eq!(row["turns"][0]["prompt_parts"], json!(["question"]));
        assert_eq!(row["turns"][0]["final_answer_parts"], json!(["answer"]));
        assert_eq!(row["turns"][0]["state"], "complete");
        assert_eq!(row["turns"][0]["turn_id"], "1");
    }
}

#[test]
fn hermes_legacy_or_nonterminal_finish_keeps_question_incomplete() {
    let f = Fixture::new();
    for finish in [
        None,
        Some("length"),
        Some("tool_calls"),
        Some("error"),
        Some("content_filter"),
    ] {
        let source = hermes(&f, "session.jsonl", false, finish);
        let row = f.discover_then_extract("hermes", &source);
        assert_eq!(row["status"], "parsed");
        assert_eq!(row["turns"][0]["prompt_parts"], json!(["question"]));
        assert_eq!(row["turns"][0]["state"], "incomplete");
        assert_eq!(row["turns"][0]["final_answer_parts"], json!([]));
    }
}

#[test]
fn hermes_any_later_or_nested_cross_project_metadata_blocks_the_entire_file() {
    let f = Fixture::new();
    for metadata in [
        json!({"type":"session","id":"hermes-01","cwd":"/other-project"}),
        json!({"type":"message","message":{"role":"assistant","cwd":"/other-project","content":"PRIVATE"}}),
        json!({"type":"metadata","directory":"/other-project"}),
        json!({"type":"relocated","relocatedCwd":"/other-project"}),
        json!({"type":"metadata","cwd":format!("{}/../other-project",f.project.display())}),
    ] {
        let source = hermes(&f, "session.jsonl", false, Some("stop"));
        let mut content = fs::read_to_string(&source).unwrap();
        content.push_str(&metadata.to_string());
        content.push('\n');
        fs::write(&source, content).unwrap();
        let row = f.extract("hermes", &source, "hermes-01");
        assert!(["cross_project_metadata_blocked", "metadata_error"]
            .contains(&row["status"].as_str().unwrap()));
        assert!(row.get("turns").is_none());
    }
}

#[test]
fn hermes_identity_children_and_ambiguous_parent_are_rejected_without_body_errors() {
    let f = Fixture::new();
    let source = hermes(&f, "session.jsonl", false, Some("stop"));
    assert_eq!(
        f.extract("hermes", &source, "wrong")["status"],
        "metadata_error"
    );
    for metadata in [
        json!({"type":"session","id":"different","cwd":f.project}),
        json!({"session_id":"different"}),
        json!({"parent_session_id":"parent"}),
        json!({"parent_session_id":{"content":"PRIVATE_ERROR_SENTINEL"}}),
    ] {
        hermes(&f, "session.jsonl", false, Some("stop"));
        let mut content = fs::read_to_string(&source).unwrap();
        content.push_str(&metadata.to_string());
        content.push('\n');
        fs::write(&source, content).unwrap();
        let row = f.extract("hermes", &source, "hermes-01");
        assert_eq!(row["status"], "metadata_error");
        assert!(!row.to_string().contains("PRIVATE_ERROR_SENTINEL"));
    }
    let source = f.write(
        "wrong-project.jsonl",
        format!(
            "{}\n",
            json!({"type":"session","id":"hermes-01","cwd":"/other-project"})
        )
        .into_bytes(),
    );
    use std::io::Write;
    fs::OpenOptions::new()
        .append(true)
        .open(&source)
        .unwrap()
        .write_all(b"\xffINVALID_PRIVATE_BODY")
        .unwrap();
    assert_eq!(
        f.extract("hermes", &source, "hermes-01")["status"],
        "cross_project_metadata_blocked"
    );
    let array = f.write(
        "array.json",
        json!([{"type":"session","id":"hermes-01","cwd":f.project}]).to_string(),
    );
    assert_eq!(
        f.extract("hermes", &array, "hermes-01")["status"],
        "metadata_error"
    );
}

fn opencode(f: &Fixture) -> PathBuf {
    let source = f.write(
        "storage/session/project/ses_01.json",
        json!({"id":"ses_01","directory":f.project,"parentID":"","title":"PRIVATE_TITLE"})
            .to_string(),
    );
    f.write("storage/message/ses_01/msg_u.json",json!({"id":"msg_u","sessionID":"ses_01","role":"user","time":{"created":1793273127000_u64}}).to_string());
    f.write("storage/message/ses_01/msg_a.json",json!({"id":"msg_a","sessionID":"ses_01","parentID":"msg_u","role":"assistant","finish":"stop","path":{"cwd":f.project,"root":f.project},"time":{"created":1793273128000_u64}}).to_string());
    for (message, id, text) in [("msg_u", "prt_u", "question"), ("msg_a", "prt_a", "answer")] {
        f.write(
            &format!("storage/part/{message}/{id}.json"),
            json!({"id":id,"sessionID":"ses_01","messageID":message,"type":"text","text":text})
                .to_string(),
        );
    }
    source
}

#[test]
fn opencode_session_metadata_path_is_adapted_to_authorized_message_and_part_storage() {
    let f = Fixture::new();
    let source = opencode(&f);
    let row = f.discover_then_extract("opencode", &source);
    assert_eq!(row["status"], "parsed");
    assert_eq!(row["turns"][0]["prompt_parts"], json!(["question"]));
    assert_eq!(row["turns"][0]["final_answer_parts"], json!(["answer"]));
    assert_eq!(row["turns"][0]["state"], "complete");
    assert!(!row["turns"].to_string().contains("PRIVATE_TITLE"));
    assert_eq!(
        f.extract("opencode", &source, "ses_wrong")["status"],
        "metadata_error"
    );
}

#[test]
fn opencode_rejects_foreign_session_message_part_or_project_before_loading() {
    let f = Fixture::new();
    let cases = [
        (
            "storage/session/project/ses_01.json",
            json!({"id":"ses_01","directory":"/other-project"}),
            "cross_project_metadata_blocked",
        ),
        (
            "storage/session/project/ses_01.json",
            json!({"id":"ses_01","directory":f.project,"parentID":"ses_parent"}),
            "metadata_error",
        ),
        (
            "storage/message/ses_01/msg_a.json",
            json!({"id":"msg_a","sessionID":"ses_foreign"}),
            "metadata_error",
        ),
        (
            "storage/message/ses_01/msg_a.json",
            json!({"id":"msg_wrong","sessionID":"ses_01"}),
            "metadata_error",
        ),
        (
            "storage/message/ses_01/msg_a.json",
            json!({"id":"msg_a","sessionID":"ses_01","path":{"cwd":"/other-project"}}),
            "cross_project_metadata_blocked",
        ),
        (
            "storage/part/msg_a/prt_a.json",
            json!({"id":"prt_a","sessionID":"ses_01","messageID":"msg_foreign"}),
            "metadata_error",
        ),
        (
            "storage/part/msg_a/prt_a.json",
            json!({"id":"prt_a","sessionID":"ses_01","messageID":"msg_a","directory":"/other-project"}),
            "cross_project_metadata_blocked",
        ),
        (
            "storage/part/msg_a/prt_a.json",
            json!({"id":"prt_a","sessionID":"ses_01"}),
            "metadata_error",
        ),
    ];
    for (path, metadata, status) in cases {
        let source = opencode(&f);
        f.write(path, metadata.to_string());
        let row = f.extract("opencode", &source, "ses_01");
        assert_eq!(row["status"], status);
        assert!(row.get("turns").is_none());
    }
}

#[cfg(unix)]
#[test]
fn opencode_rejects_symbolic_links_to_unapproved_part_storage() {
    let f = Fixture::new();
    let source = opencode(&f);
    fs::rename(
        f.root.join("storage/part/msg_a"),
        f.root.join("unapproved-parts"),
    )
    .unwrap();
    std::os::unix::fs::symlink(
        f.root.join("unapproved-parts"),
        f.root.join("storage/part/msg_a"),
    )
    .unwrap();
    let row = f.extract("opencode", &source, "ses_01");
    assert_eq!(row["status"], "metadata_error");
    assert!(row.get("turns").is_none());
}

#[test]
fn hermes_tool_activity_after_terminal_text_still_requires_new_terminal_reply() {
    let f = Fixture::new();
    let source = hermes(&f, "session.jsonl", true, Some("stop"));
    let mut content = fs::read_to_string(&source).unwrap();
    content.push_str(
        &json!({"type":"message","message":{"id":3,"role":"tool","content":"tool output"}})
            .to_string(),
    );
    content.push('\n');
    fs::write(&source, &content).unwrap();
    assert_eq!(
        f.extract("hermes", &source, "hermes-01")["turns"][0]["state"],
        "incomplete"
    );
    content.push_str(&json!({"type":"message","message":{"id":4,"role":"assistant","content":"final after tool","finish_reason":"end_turn"}}).to_string());
    content.push('\n');
    fs::write(&source, content).unwrap();
    let row = f.extract("hermes", &source, "hermes-01");
    assert_eq!(row["turns"][0]["state"], "complete");
    assert_eq!(
        row["turns"][0]["final_answer_parts"],
        json!(["final after tool"])
    );
}
