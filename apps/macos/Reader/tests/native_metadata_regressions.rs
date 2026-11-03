mod support;
use serde_json::{json, Value};
use std::{fs, path::PathBuf};
use support::Fixture;

const PRIVATE: &str = "PRIVATE_NATIVE_BODY_NOT_AN_ERROR";

fn codex(f: &Fixture) -> PathBuf {
    f.lines("codex.jsonl", &[
        json!({"type":"session_meta","payload":{"id":"codex-native","cwd":f.project,"source":"cli"},"path":"ordinary-file-path"}),
        json!({"type":"event_msg","payload":{"type":"user_message","message":PRIVATE}}),
        json!({"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100},"last_token_usage":{"output_tokens":20}}}}),
        json!({"type":"response_item","payload":{"type":"message","id":"u1","role":"user","content":[{"type":"input_text","text":"question"}]}}),
        json!({"type":"response_item","payload":{"type":"message","id":"a1","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"answer"}]}}),
    ])
}

fn claude(f: &Fixture) -> PathBuf {
    f.lines("claude.jsonl", &[
        json!({"type":"user","uuid":"u1","id":"api-user","sessionId":"cli-native","session_id":"sdk-backend-user","cwd":f.project,"message":{"role":"user","content":"question"}}),
        json!({"type":"attachment","sessionId":"cli-native","session_id":"sdk-backend-attachment","cwd":f.project,"attachment":{"content":PRIVATE}}),
        json!({"type":"backend_event","session_id":"backend-only-record","info":PRIVATE}),
        json!({"type":"assistant","uuid":"a1","sessionId":"cli-native","session_id":"sdk-backend-assistant","cwd":f.project,"message":{"id":"api-a1","role":"assistant","content":[{"type":"text","text":"answer"}],"stop_reason":"end_turn"}}),
    ])
}

fn append(path: &std::path::Path, tail: &[u8]) {
    use std::io::Write;
    fs::OpenOptions::new()
        .append(true)
        .open(path)
        .unwrap()
        .write_all(tail)
        .unwrap();
}

fn assert_history(row: &Value) {
    assert_eq!(row["status"], "parsed");
    assert_eq!(row["turns"][0]["prompt_parts"], json!(["question"]));
    assert_eq!(row["turns"][0]["final_answer_parts"], json!(["answer"]));
    assert_eq!(row["turns"][0]["state"], "complete");
}

#[test]
fn codex_native_event_message_string_token_info_and_path_string_are_valid() {
    let f = Fixture::new();
    let source = codex(&f);
    assert_history(&f.discover_then_extract("codex", &source));
    let compressed = f.write(
        "codex.jsonl.zst",
        zstd::stream::encode_all(fs::read(&source).unwrap().as_slice(), 1).unwrap(),
    );
    assert_history(&f.discover_then_extract("codex", &compressed));
}

#[test]
fn nested_body_scalars_and_arrays_are_ignored_but_maps_still_validate_metadata() {
    let f = Fixture::new();
    for field in ["payload", "info", "message", "custom", "path"] {
        for value in [
            json!(PRIVATE),
            json!(true),
            json!(42),
            json!(0.25),
            Value::Null,
            json!([{"cwd":"/ordinary-body-data", "content":PRIVATE}, PRIVATE, 1]),
        ] {
            let source = codex(&f);
            let mut event = json!({"type":"ordinary_event"});
            event[field] = value;
            append(&source, format!("{event}\n").as_bytes());
            assert_history(&f.extract("codex", &source, "codex-native"));
        }
        let source = codex(&f);
        let mut event = json!({"type":"ordinary_event"});
        event[field] = json!({"cwd":{"content":PRIVATE}});
        append(&source, format!("{event}\n").as_bytes());
        let row = f.extract("codex", &source, "codex-native");
        assert_eq!(row["status"], "metadata_error");
        assert!(!row.to_string().contains(PRIVATE));
        let source = codex(&f);
        event[field] = json!({"cwd":"/unapproved-project"});
        append(&source, format!("{event}\n").as_bytes());
        assert_eq!(
            f.extract("codex", &source, "codex-native")["status"],
            "cross_project_metadata_blocked"
        );
    }
}

#[test]
fn claude_cli_identity_is_independent_of_backend_snake_session_ids() {
    let f = Fixture::new();
    let source = claude(&f);
    let (rows, process) = f.locate(json!([{"provider":"claude","source":source}]));
    assert_eq!(rows[0]["status"], "located");
    assert_eq!(rows[0]["session_id"], "cli-native");
    assert!(process.stdout.is_empty());
    assert!(process.stderr.is_empty());
    assert_history(&f.extract("claude", &source, "cli-native"));
    assert_eq!(
        f.extract("claude", &source, "sdk-backend-user")["status"],
        "metadata_error"
    );
    for (metadata, status) in [
        (
            json!({"sessionId":"different-cli","session_id":"cli-native"}),
            "metadata_error",
        ),
        (
            json!({"sessionId":"cli-native","cwd":"/other-project"}),
            "cross_project_metadata_blocked",
        ),
        (
            json!({"type":"relocated","sessionId":"cli-native","relocatedCwd":"/other-project"}),
            "cross_project_metadata_blocked",
        ),
    ] {
        let source = claude(&f);
        append(&source, format!("{metadata}\n").as_bytes());
        assert_eq!(f.extract("claude", &source, "cli-native")["status"], status);
    }
    let source = f.lines("backend-only.jsonl", &[json!({"type":"user","session_id":"backend-only","cwd":f.project,"message":{"role":"user","content":PRIVATE}})]);
    let (rows, _) = f.locate(json!([{"provider":"claude","source":source}]));
    assert_eq!(rows[0]["status"], "metadata_error");
    assert!(!rows[0].to_string().contains(PRIVATE));
}

#[test]
fn only_unterminated_incomplete_jsonl_tail_is_tolerated() {
    let f = Fixture::new();
    for (provider, id) in [("codex", "codex-native"), ("claude", "cli-native")] {
        for tail in [
            b"{\"type\":\"event_msg\",\"payload\":{\"message\":\"unfinished".as_slice(),
            b"{\"cwd\":".as_slice(),
        ] {
            let source = if provider == "codex" {
                codex(&f)
            } else {
                claude(&f)
            };
            append(&source, tail);
            assert_history(&f.extract(provider, &source, id));
            // A newline makes the exact same malformed record a hard error.
            append(&source, b"\n");
            let row = f.extract(provider, &source, id);
            assert_eq!(row["status"], "metadata_error");
            assert!(row.get("turns").is_none());
        }
        for tail in [
            b"{\"cwd\":???}".as_slice(),
            b"{\"cwd\":42}".as_slice(),
            b"{\"cwd\":42".as_slice(),
            b"{\"message\":\"bad\\q\"}".as_slice(),
        ] {
            let source = if provider == "codex" {
                codex(&f)
            } else {
                claude(&f)
            };
            append(&source, tail);
            assert_eq!(f.extract(provider, &source, id)["status"], "metadata_error");
        }
        let source = if provider == "codex" {
            codex(&f)
        } else {
            claude(&f)
        };
        append(&source, b"{\"cwd\":\"/other-project\"}");
        assert_eq!(
            f.extract(provider, &source, id)["status"],
            "cross_project_metadata_blocked"
        );
        let source = if provider == "codex" {
            codex(&f)
        } else {
            claude(&f)
        };
        let mut bytes = fs::read(&source).unwrap();
        assert_eq!(bytes.pop(), Some(b'\n'));
        fs::write(&source, bytes).unwrap();
        assert_history(&f.extract(provider, &source, id));
    }
}

#[test]
fn in_progress_utf8_tail_does_not_hide_completed_history_for_any_jsonl_provider() {
    let f = Fixture::new();
    for provider in ["codex", "claude", "pi", "omp", "hermes"] {
        let (source, id) = match provider {
            "codex" => (codex(&f), "codex-native"),
            "claude" => (claude(&f), "cli-native"),
            "hermes" => (f.lines("hermes.jsonl", &[
                json!({"type":"session","id":"native-history","cwd":f.project}),
                json!({"role":"user","content":"question"}),
                json!({"role":"assistant","content":"answer","finish_reason":"stop"}),
            ]), "native-history"),
            _ => (f.lines(&format!("{provider}.jsonl"), &[
                json!({"type":"session","id":"native-history","version":3,"cwd":f.project}),
                json!({"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"question"}]}}),
                json!({"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","content":[{"type":"text","text":"answer"}],"stopReason":"stop"}}),
            ]), "native-history"),
        };
        append(&source, b"{\"message\":\"unfinished multibyte \xe4\xb8");
        assert_history(&f.extract(provider, &source, id));
        if provider == "codex" {
            let compressed = f.write(
                "partial-tail.jsonl.zst",
                zstd::stream::encode_all(fs::read(&source).unwrap().as_slice(), 1).unwrap(),
            );
            assert_history(&f.extract(provider, &compressed, id));
        }
        append(&source, b"\n");
        let row = f.extract(provider, &source, id);
        assert_eq!(row["status"], "metadata_error");
        assert!(row.get("turns").is_none());
    }
}
