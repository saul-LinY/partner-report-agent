mod support;
use serde_json::json;
use std::fs;
use support::Fixture;

const PRIVATE: &str = "PRIVATE_BODY_MUST_NEVER_APPEAR_IN_LOCATE";

#[test]
fn claude_long_first_user_record_accepts_eight_mib_and_rejects_only_over_budget() {
    let f = Fixture::new();
    for (size, status) in [
        (2 * 1024 * 1024, "located"),
        (8 * 1024 * 1024, "located"),
        (8 * 1024 * 1024 + 1, "metadata_error"),
    ] {
        let mut header = json!({
            "type":"user", "sessionId":"long-claude", "cwd":f.project,
            "message":{"role":"user", "content":""}
        });
        let overhead = header.to_string().len() + 1;
        header["message"]["content"] = json!("x".repeat(size - overhead - PRIVATE.len()) + PRIVATE);
        let mut bytes = format!("{header}\n").into_bytes();
        assert_eq!(bytes.len(), size);
        // Locating a long record must still stop at its header, not parse the tail.
        bytes.extend_from_slice(b"\xffINVALID_PRIVATE_TAIL");
        let source = f.write("long-claude.jsonl", bytes);
        let (rows, process) = f.locate(json!([{"provider":"claude","source":source}]));
        assert_eq!(rows[0]["status"], status);
        assert_eq!(rows[0]["provider"], "claude");
        assert_eq!(rows[0]["source"], source.to_str().unwrap());
        if status == "located" {
            assert_eq!(rows[0]["session_id"], "long-claude");
            assert_eq!(rows[0]["cwd"], f.project.to_str().unwrap());
        }
        let output = serde_json::to_string(&rows).unwrap();
        assert!(output.len() < 1024);
        assert!(!output.contains(PRIVATE));
        assert!(process.stdout.is_empty());
        assert!(process.stderr.is_empty());
    }
}

#[test]
fn batch_cli_locates_all_file_headers_without_parsing_or_projecting_body() {
    let f = Fixture::new();
    let mut requests = Vec::new();
    for provider in ["codex", "claude", "pi", "omp", "hermes", "opencode"] {
        let header = match provider {
            "codex" => {
                json!({"type":"session_meta","payload":{"id":"session-01","cwd":f.project,"source":"cli"}})
            }
            "claude" => {
                json!({"type":"user","sessionId":"session-01","cwd":f.project,"isSidechain":false,
                "message":{"content":PRIVATE},"prompt":PRIVATE})
            }
            "opencode" => {
                json!({"id":"session-01","directory":f.project,"parentID":null,"title":PRIVATE,"content":PRIVATE})
            }
            _ => {
                json!({"type":"session","id":"session-01","cwd":f.project,"title":{"content":PRIVATE}})
            }
        };
        let source = if provider == "opencode" {
            f.write(
                "storage/session/project/session-01.json",
                header.to_string(),
            )
        } else {
            let mut bytes = if provider == "omp" {
                format!("{{\"type\":\"title\",\"title\":\"{PRIVATE}\"}}\n{header}\n").into_bytes()
            } else {
                format!("{header}\n").into_bytes()
            };
            // Invalid UTF-8 and invalid JSON after the header must never be parsed.
            bytes.extend_from_slice(b"\xffNOT_JSON_BODY");
            f.write(&format!("{provider}/session.jsonl"), bytes)
        };
        requests.push(json!({"provider":provider,"source":source}));
    }
    let (rows, process) = f.locate(json!(requests));
    assert!(process.stdout.is_empty());
    assert!(process.stderr.is_empty());
    for (request, row) in requests.iter().zip(&rows) {
        assert_eq!(row["provider"], request["provider"]);
        assert_eq!(row["source"], request["source"]);
        assert_eq!(row["status"], "located");
        assert_eq!(row["session_id"], "session-01");
        assert_eq!(row["cwd"], f.project.to_str().unwrap());
        let keys: Vec<_> = row
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert!(keys
            .iter()
            .all(|k| ["provider", "source", "status", "session_id", "cwd"].contains(k)));
    }
    assert!(!serde_json::to_string(&rows).unwrap().contains(PRIVATE));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(f.root.join("locate-output.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        fs::set_permissions(
            f.root.join("locate-output.json"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        f.locate(json!(requests));
        assert_eq!(
            fs::metadata(f.root.join("locate-output.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn codex_zstd_metadata_and_authorized_read_use_the_same_source() {
    let f = Fixture::new();
    let source = f.lines("history.jsonl", &[
        json!({"type":"session_meta","payload":{"id":"codex-01","cwd":f.project,"source":"cli"}}),
        json!({"type":"response_item","payload":{"type":"message","id":"u1","role":"user","content":[{"type":"input_text","text":"question"}]}}),
        json!({"type":"response_item","payload":{"type":"message","id":"a1","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"answer"}]}}),
    ]);
    let compressed = f.write(
        "history.jsonl.zst",
        zstd::stream::encode_all(fs::read(&source).unwrap().as_slice(), 1).unwrap(),
    );
    for source in [&source, &compressed] {
        let result = f.discover_then_extract("codex", source);
        assert_eq!(result["status"], "parsed");
        assert_eq!(result["turns"][0]["prompt_parts"], json!(["question"]));
        assert_eq!(result["turns"][0]["final_answer_parts"], json!(["answer"]));
        assert_eq!(
            f.extract("codex", source, "wrong-id")["status"],
            "metadata_error"
        );
    }
    let mut header = format!(
        "{}\n",
        json!({"type":"session_meta","payload":{"id":"header-only","cwd":f.project,"source":"cli"}})
    )
    .into_bytes();
    header.extend_from_slice(b"\xffPRIVATE_BODY");
    let compressed = f.write(
        "metadata-only.jsonl.zst",
        zstd::stream::encode_all(header.as_slice(), 1).unwrap(),
    );
    let (rows, process) = f.locate(json!([{"provider":"codex","source":compressed}]));
    assert_eq!(rows[0]["status"], "located");
    assert!(process.stdout.is_empty());
    assert!(process.stderr.is_empty());
}

#[test]
fn explicit_children_are_excluded_and_unknown_metadata_is_not_inferred() {
    let f = Fixture::new();
    let rows = [
        (
            "codex",
            json!({"type":"session_meta","payload":{"id":"child","cwd":f.project,"source":{"subagent":{"thread_spawn":{}}}}}),
            "excluded",
        ),
        (
            "claude",
            json!({"sessionId":"child","cwd":f.project,"isSidechain":true}),
            "excluded",
        ),
        (
            "pi",
            json!({"type":"session","id":"child","cwd":f.project,"parentSession":"parent.jsonl"}),
            "excluded",
        ),
        (
            "omp",
            json!({"type":"session","id":"child","cwd":f.project,"parent_session_id":"parent"}),
            "excluded",
        ),
        (
            "hermes",
            json!({"type":"session","id":"child","cwd":f.project,"parent_session_id":"parent"}),
            "excluded",
        ),
        (
            "opencode",
            json!({"id":"child","directory":f.project,"parentID":"parent"}),
            "excluded",
        ),
        (
            "opencode",
            json!({"id":"child","sessionID":"child","directory":f.project,"parentID":"parent"}),
            "excluded",
        ),
        (
            "hermes",
            json!({"role":"user","content":{"cwd":f.project,"id":"fake"}}),
            "metadata_error",
        ),
        (
            "pi",
            json!({"type":"session","id":"missing","title":f.project}),
            "metadata_error",
        ),
        (
            "hermes",
            json!([{"type":"session","id":"array","cwd":f.project}]),
            "metadata_error",
        ),
        (
            "pi",
            json!({"type":"session","id":"relative","cwd":"relative/project"}),
            "metadata_error",
        ),
        (
            "codex",
            json!({"type":"session_meta","payload":{"id":"ambiguous","cwd":f.project,"source":{"unknown":true}}}),
            "metadata_error",
        ),
    ];
    for (index, (provider, header, status)) in rows.into_iter().enumerate() {
        let source = f.write(
            &format!("case-{index}/child.json"),
            header.to_string() + "\n",
        );
        let (rows, process) = f.locate(json!([{"provider":provider,"source":source}]));
        assert_eq!(rows[0]["status"], status);
        assert!(process.stdout.is_empty());
        assert!(process.stderr.is_empty());
    }
    let (rows, _) = f.locate(json!([{"provider":"unknown","source":"/MUST_NOT_OPEN"}]));
    assert_eq!(rows[0]["status"], "unsupported");
}

#[test]
fn malformed_metadata_errors_never_echo_private_values() {
    let f = Fixture::new();
    let mut requests = Vec::new();
    for provider in ["codex", "claude", "pi", "omp", "hermes", "opencode"] {
        let source = f.write(
            &format!("{provider}/private.json"),
            json!({"type":PRIVATE,"id":PRIVATE,"cwd":{"content":PRIVATE},"title":PRIVATE})
                .to_string(),
        );
        requests.push(json!({"provider":provider,"source":source}));
    }
    let (rows, process) = f.locate(json!(requests));
    assert!(rows.iter().all(|r| r["status"] == "metadata_error"));
    assert!(!json!(rows).to_string().contains(PRIVATE));
    assert!(!String::from_utf8_lossy(&process.stderr).contains(PRIVATE));
    assert!(process.stdout.is_empty());
}

#[test]
fn filename_or_conflicting_metadata_identity_is_rejected() {
    let f = Fixture::new();
    for (provider, header) in [
        ("opencode", json!({"id":"different","directory":f.project})),
        (
            "hermes",
            json!({"type":"session","id":"one","sessionId":"two","cwd":f.project}),
        ),
        (
            "claude",
            json!({"sessionId":"one","cwd":f.project,"directory":"/other"}),
        ),
    ] {
        let source = f.write(&format!("{provider}/one.json"), header.to_string());
        let (rows, _) = f.locate(json!([{"provider":provider,"source":source}]));
        assert_eq!(rows[0]["status"], "metadata_error");
    }
}

#[test]
fn claude_pi_and_omp_discovery_to_authorized_read_and_cross_project_rejection() {
    let f = Fixture::new();
    for provider in ["claude", "pi", "omp"] {
        let rows = if provider == "claude" {
            vec![
                json!({"type":"user","sessionId":"session-01","cwd":f.project,"uuid":"u1","message":{"role":"user","content":"question"}}),
                json!({"type":"assistant","sessionId":"session-01","cwd":f.project,"uuid":"a1","message":{"role":"assistant","content":[{"type":"text","text":"answer"}],"stop_reason":"end_turn"}}),
            ]
        } else {
            vec![
                json!({"type":"session","id":"session-01","version":3,"cwd":f.project}),
                json!({"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"question"}]}}),
                json!({"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","content":[{"type":"text","text":"answer"}],"stopReason":"stop"}}),
            ]
        };
        let source = f.lines(&format!("{provider}/session.jsonl"), &rows);
        let result = f.discover_then_extract(provider, &source);
        assert_eq!(result["status"], "parsed");
        assert_eq!(result["turns"][0]["prompt_parts"], json!(["question"]));
        assert_eq!(result["turns"][0]["state"], "complete");
        let mut text = fs::read_to_string(&source).unwrap();
        text.push_str(
            &json!({"type":"metadata","cwd":"/unapproved","sessionId":"session-01"}).to_string(),
        );
        text.push('\n');
        fs::write(&source, text).unwrap();
        assert_eq!(
            f.extract(provider, &source, "session-01")["status"],
            "cross_project_metadata_blocked"
        );
    }
}
