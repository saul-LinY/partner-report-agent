// DeepSeek Harness session reader. Session reading only; no write or resume paths.
//
// A session is `<sessions>/--<project path with / as ->--/session-<uuid>/session.v4.jsonl.zstd`: a zstd-compressed
// JSONL event log. One record per line: `{ "type", "seq", "time" (ms epoch), "data" }`; the first record is the
// `session` header (`id`, `cwd`, `delegationDepth`).
//
// What counts as what:
//  * a prompt is a `user/message` whose `source.kind == "user"`; the same record type also carries injected
//    runtime/time/skill-catalog context, which is never a prompt;
//  * `assistant/message` holds `reasoning`, `tool-call` and `text` blocks per step. Reasoning is dropped here, so it
//    can never reach an upload;
//  * a turn is `turn/start` .. `turn/end`; `turn/end` with `reason.kind == "completed"` is the native completion signal.
#![allow(dead_code, unused_imports)]
use super::blocks::openai_tool_calls;
use super::utils::LineSpans;
use crate::session_manager::model::{MessageMeta, SessionBlock};
use crate::session_manager::SessionMessage;
use serde_json::Value;
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

/// Native turn numbers are namespaced so they can never collide with the parser-generated `t{n}` keys.
pub(crate) fn turn_key(turn: u64) -> String {
    format!("d{turn}")
}

/// Streams the decompressed event log. A damaged or truncated tail ends the read; records before it are kept.
pub(crate) fn open_records(path: &Path) -> Result<Box<dyn BufRead>, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open DeepSeek session: {e}"))?;
    let decoder = zstd::stream::read::Decoder::new(file)
        .map_err(|e| format!("Failed to decompress DeepSeek session: {e}"))?;
    Ok(Box::new(BufReader::with_capacity(256 * 1024, decoder)))
}

/// Every parseable record, in file order.
pub(crate) fn for_each_record(
    path: &Path,
    mut f: impl FnMut(&Value) -> Result<(), String>,
) -> Result<(), String> {
    let mut lines = LineSpans::new(open_records(path)?);
    loop {
        let line = match lines.next_line() {
            Ok(Some(line)) => line,
            // A writer that is still appending can leave a half-written zstd frame at the end.
            Ok(None) | Err(_) => return Ok(()),
        };
        let bytes = line.bytes.trim_ascii();
        if bytes.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
            continue;
        };
        f(&value)?;
    }
}

fn is_prompt(data: &Value) -> bool {
    data.pointer("/source/kind").and_then(Value::as_str) == Some("user")
}

fn blocks_of(content: &Value) -> Vec<SessionBlock> {
    let Some(items) = content.as_array() else {
        return Vec::new();
    };
    let mut blocks = Vec::new();
    let mut calls = Vec::new();
    for item in items {
        match item.get("type").and_then(Value::as_str) {
            Some("text") => {
                let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
                if !text.trim().is_empty() {
                    blocks.push(SessionBlock::text(text.to_string()));
                }
            }
            Some("tool-call") => calls.push(serde_json::json!({
                "id": item.get("id").or_else(|| item.get("callId")).cloned().unwrap_or(Value::Null),
                "name": item.get("name").or_else(|| item.get("toolName")).cloned().unwrap_or(Value::Null),
                "arguments": item.get("arguments").or_else(|| item.get("input")).cloned().unwrap_or(Value::Null),
            })),
            // `reasoning` and anything unknown: dropped on purpose.
            _ => {}
        }
    }
    blocks.extend(openai_tool_calls(Some(&Value::Array(calls)), |_| None));
    blocks
}

pub fn load_messages(path: &Path) -> Result<Vec<SessionMessage>, String> {
    let mut messages: Vec<SessionMessage> = Vec::new();
    let mut active: Option<u64> = None;
    for_each_record(path, |record| {
        let kind = record.get("type").and_then(Value::as_str).unwrap_or("");
        let data = record.get("data").unwrap_or(&Value::Null);
        let seq = record.get("seq").and_then(Value::as_u64);
        let ts = record.get("time").and_then(Value::as_i64);
        match kind {
            "turn/start" => active = data.get("turn").and_then(Value::as_u64),
            "turn/end" => active = None,
            "user/message" => {
                let text = data
                    .get("content")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                            .filter_map(|b| b.get("text").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default();
                if text.trim().is_empty() {
                    return Ok(());
                }
                let mut message = SessionMessage::from_blocks("user", ts, vec![SessionBlock::text(text)]);
                message.id = Some(format!("user-{}", seq.unwrap_or(messages.len() as u64)));
                message.turn_id = data.get("turn").and_then(Value::as_u64).map(turn_key).or(active.map(turn_key));
                message.injected = !is_prompt(data);
                messages.push(message);
            }
            "assistant/message" => {
                let blocks = blocks_of(data.pointer("/message/content").unwrap_or(&Value::Null));
                let has_call = blocks.iter().any(|b| matches!(b, SessionBlock::ToolCall { .. }));
                let mut message = SessionMessage::from_blocks("assistant", ts, blocks);
                if message.is_empty() {
                    return Ok(());
                }
                message.id = Some(format!("step-{}", seq.unwrap_or(messages.len() as u64)));
                message.turn_id = data.get("turn").and_then(Value::as_u64).map(turn_key).or(active.map(turn_key));
                message.meta = Some(MessageMeta {
                    model: data.pointer("/message/source/model").and_then(Value::as_str).map(str::to_string),
                    stop_reason: has_call.then(|| "tool_use".to_string()),
                    ..Default::default()
                });
                messages.push(message);
            }
            _ => {}
        }
        Ok(())
    })?;
    super::blocks::assign_turn_ids(&mut messages);
    Ok(messages)
}

/// Turns whose `turn/end` says `completed`. A later `turn/start` for the same turn number clears it, so a resumed
/// turn is not reported complete until it ends again.
pub(crate) fn completed_turns(path: &Path) -> Result<HashSet<String>, String> {
    let mut completed = HashSet::new();
    let mut active: Option<u64> = None;
    for_each_record(path, |record| {
        let data = record.get("data").unwrap_or(&Value::Null);
        match record.get("type").and_then(Value::as_str) {
            Some("turn/start") => {
                active = data.get("turn").and_then(Value::as_u64);
                if let Some(turn) = active {
                    completed.remove(&turn_key(turn));
                }
            }
            Some("turn/end") => {
                let turn = data.get("turn").and_then(Value::as_u64).or(active.take());
                if let Some(turn) = turn {
                    if data.pointer("/reason/kind").and_then(Value::as_str) == Some("completed") {
                        completed.insert(turn_key(turn));
                    } else {
                        completed.remove(&turn_key(turn));
                    }
                }
            }
            _ => {}
        }
        Ok(())
    })?;
    Ok(completed)
}
