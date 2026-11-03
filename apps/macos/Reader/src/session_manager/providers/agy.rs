// Derived from CC Switch 4.0.21 (6d6b716); MIT, Copyright (c) 2025 Jason Young.
// Session reading only. See UPSTREAM.json and LICENSE.
#![allow(dead_code, unused_imports)]
use super::{
    blocks::assign_turn_ids,
    utils::{parse_timestamp_to_ms, truncate_summary},
};
use crate::session_manager::model::{MessageMeta, SessionBlock};
use crate::session_manager::SessionMessage;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};
pub(crate) fn records(path: &Path) -> Result<Vec<Value>, String> {
    let file =
        fs::File::open(path).map_err(|e| format!("Cannot read Antigravity transcript: {e}"))?;
    let mut steps = BTreeMap::new();
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|e| format!("Cannot read Antigravity transcript: {e}"))?;
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(index) = value["step_index"].as_u64() {
            steps.insert(index, value);
        }
    }
    Ok(steps.into_values().collect())
}
/// agy stores each prompt wrapped in `<USER_REQUEST>`, followed by context it adds itself
/// (`<ADDITIONAL_METADATA>`, `<USER_SETTINGS_CHANGE>`, ...). Only the part the user typed is shown.
fn user_request(content: &str) -> &str {
    content
        .split_once("<USER_REQUEST>")
        .and_then(|(_, rest)| rest.split_once("</USER_REQUEST>"))
        .map(|(inner, _)| inner.trim())
        .filter(|inner| !inner.is_empty())
        .unwrap_or(content)
}
pub(crate) fn timestamp(value: &Value) -> Option<i64> {
    parse_timestamp_to_ms(&value["created_at"])
}
pub fn load_messages(path: &Path) -> Result<Vec<SessionMessage>, String> {
    let mut messages = Vec::new();
    for value in records(path)? {
        let role = match value["type"].as_str() {
            Some("USER_INPUT") => "user",
            Some("PLANNER_RESPONSE") => "assistant",
            // Generic MODEL records include tool invocations and internal execution text.
            _ => continue,
        };
        let content = value["content"].as_str().unwrap_or("");
        let content = if role == "user" {
            user_request(content)
        } else {
            content
        };
        if content.trim().is_empty() { continue; }
        let content = content.to_string();
        let mut message = SessionMessage::from_blocks(
            role,
            timestamp(&value),
            vec![SessionBlock::Text {
                text: content,
                full: None,
            }],
        );
        message.id = value["step_index"].as_u64().map(|n| n.to_string());
        message.meta = Some(MessageMeta {
            model: value["model"].as_str().map(String::from),
            input_tokens: value["input_tokens"].as_u64(),
            output_tokens: value["output_tokens"].as_u64(),
            cache_read_tokens: value["cache_read_tokens"].as_u64(),
            cache_write_tokens: value["cache_write_tokens"].as_u64(),
            reasoning_tokens: value["reasoning_tokens"].as_u64(),
            ..Default::default()
        });
        messages.push(message);
    }
    assign_turn_ids(&mut messages);
    Ok(messages)
}
