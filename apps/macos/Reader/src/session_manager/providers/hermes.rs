// Derived from CC Switch 4.0.21 (6d6b716); MIT, Copyright (c) 2025 Jason Young.
// Session reading only. See UPSTREAM.json and LICENSE.
#![allow(dead_code, unused_imports)]
use super::blocks::{assign_turn_ids, openai_tool_calls, thinking_block, tool_result_block};
use super::utils::for_each_jsonl_value;
use super::utils::{
    extract_text, parse_timestamp_to_ms, read_head_tail_lines, truncate_summary, TITLE_MAX_CHARS,
};
use crate::session_manager::model::{ContentRef, MessageMeta, SessionBlock, ToolStatus};
use crate::session_manager::SessionMessage;
use rusqlite::Connection;
use serde_json::Value;
use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
/// Hermes stores non-string message content (text + image parts, …) as this
/// prefix followed by JSON (`SessionDB._encode_content`).
const CONTENT_JSON_PREFIX: &str = "\u{0}json:";
/// Rows Hermes itself shows in a transcript: live rows plus rows archived by
/// context compression (`compacted = 1`), but not rows hidden by
/// undo/rewind/regenerate (`active = 0, compacted = 0`). Older stores predate
/// these columns and show everything.
fn display_filter(columns: &[String]) -> &'static str {
    let has = |name: &str| columns.iter().any(|c| c == name);
    match (has("active"), has("compacted")) {
        (true, true) => " AND (active = 1 OR compacted = 1)",
        (true, false) => " AND active = 1",
        _ => "",
    }
}
/// Undo `SessionDB._encode_content`: structured content becomes its text parts.
fn decode_content(raw: &str) -> String {
    match raw.strip_prefix(CONTENT_JSON_PREFIX) {
        Some(json) => match serde_json::from_str::<Value>(json) {
            Ok(value) => extract_text(&value),
            Err(_) => raw.to_string(),
        },
        None => raw.to_string(),
    }
}
/// Get column names for a table.
fn get_table_columns(conn: &Connection, table: &str) -> Vec<String> {
    let query = format!("PRAGMA table_info({table})");
    let mut stmt = match conn.prepare(&query) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = match stmt.query_map([], |row| {
        let name: String = row.get(1)?;
        Ok(name)
    }) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    rows.flatten().collect()
}
/// Load messages from the Hermes SQLite database.
pub fn load_messages_sqlite(source: &str) -> Result<Vec<SessionMessage>, String> {
    let (db_path, session_id) = parse_sqlite_source(source)
        .ok_or_else(|| format!("Invalid SQLite source reference: {source}"))?;
    #[cfg(windows)]
    if crate::session_manager::hermes_wsl::is_wsl(&db_path) {
        let data = crate::session_manager::hermes_wsl::read(
            &db_path,
            serde_json::json!({ "operation" : "messages", "session_id" : session_id }),
        )?;
        let rows: Vec<MessageRow> = data
            .as_array()
            .ok_or("Invalid Hermes message response")?
            .iter()
            .filter_map(|row| {
                let text = |name: &str| row[name].as_str().map(str::to_string);
                Some(MessageRow {
                    id: row["id"].as_i64()?,
                    role: row["role"].as_str()?.to_string(),
                    content: text("content"),
                    timestamp: row["timestamp"].as_f64(),
                    tool_call_id: text("tool_call_id"),
                    tool_calls: text("tool_calls"),
                    tool_name: text("tool_name"),
                    active: row["active"].as_i64().unwrap_or(1),
                    display_metadata: text("display_metadata"),
                    reasoning: text("reasoning"),
                    finish_reason: text("finish_reason"),
                })
            })
            .collect();
        return messages_from_rows(rows);
    }
    let conn = Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("Failed to open Hermes database: {e}"))?;
    load_messages_from_conn(&conn, &session_id)
}
type DedupeKey = (
    String,
    Option<String>,
    Option<u64>,
    Option<String>,
    Option<String>,
    Option<String>,
);
struct MessageRow {
    id: i64,
    role: String,
    content: Option<String>,
    timestamp: Option<f64>,
    tool_call_id: Option<String>,
    tool_calls: Option<String>,
    tool_name: Option<String>,
    active: i64,
    display_metadata: Option<String>,
    /// 助手推理单独映射为 Thinking，不参与正式回复输出。
    reasoning: Option<String>,
    finish_reason: Option<String>,
}
impl MessageRow {
    /// Hermes' display identity (`SessionDB._display_dedupe_key`): compression
    /// re-inserts protected head/tail rows with their original timestamp, so
    /// the archived original and the live copy are the same message.
    fn dedupe_key(&self) -> DedupeKey {
        (
            self.role.clone(),
            self.content.clone(),
            self.timestamp.map(f64::to_bits),
            self.tool_call_id.clone(),
            self.tool_calls.clone(),
            self.tool_name.clone(),
        )
    }
    /// Rows the model reads but nobody typed as one message (micro-compaction
    /// merges) carry `display_metadata.model_only`; their sources stay visible.
    fn is_model_only(&self) -> bool {
        let Some(raw) = self.display_metadata.as_deref() else {
            return false;
        };
        let mut meta: Value = Value::String(raw.to_string());
        for _ in 0..2 {
            if let Value::String(s) = &meta {
                meta = match serde_json::from_str(s) {
                    Ok(v) => v,
                    Err(_) => return false,
                };
            }
        }
        match meta.get("model_only") {
            Some(Value::Bool(b)) => *b,
            Some(Value::Number(n)) => n.as_f64() != Some(0.0),
            Some(Value::String(s)) => !s.is_empty(),
            _ => false,
        }
    }
}
fn load_messages_from_conn(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<SessionMessage>, String> {
    let columns = get_table_columns(conn, "messages");
    let col = |name: &str| {
        if columns.iter().any(|c| c == name) {
            name.to_string()
        } else {
            format!("NULL AS {name}")
        }
    };
    let query = format!(
        "SELECT id, role, content, {timestamp}, {tool_call_id}, {tool_calls}, {tool_name}, \
                {active}, {display_metadata}, {reasoning}, {finish_reason} \
         FROM messages WHERE session_id = ?1{filter} ORDER BY id ASC",
        timestamp = col("timestamp"),
        tool_call_id = col("tool_call_id"),
        tool_calls = col("tool_calls"),
        tool_name = col("tool_name"),
        active = col("active"),
        display_metadata = col("display_metadata"),
        reasoning = col("reasoning"),
        finish_reason = col("finish_reason"),
        filter = display_filter(&columns),
    );
    let mut stmt = conn
        .prepare(&query)
        .map_err(|e| format!("Failed to prepare messages query: {e}"))?;
    let rows = stmt
        .query_map([session_id], |row| {
            Ok(MessageRow {
                id: row.get(0)?,
                role: row.get(1)?,
                content: row.get(2).ok().flatten(),
                timestamp: row.get(3).ok().flatten(),
                tool_call_id: row.get(4).ok().flatten(),
                tool_calls: row.get(5).ok().flatten(),
                tool_name: row.get(6).ok().flatten(),
                active: row.get::<_, Option<i64>>(7).ok().flatten().unwrap_or(1),
                display_metadata: row.get(8).ok().flatten(),
                reasoning: row.get(9).ok().flatten(),
                finish_reason: row.get(10).ok().flatten(),
            })
        })
        .map_err(|e| format!("Failed to query messages: {e}"))?;
    let mut messages = messages_from_rows(rows.flatten())?;
    // Session-level model is metadata, not a reason to wait for the whole CLI session to close.
    if get_table_columns(conn, "sessions").iter().any(|c| c == "model") {
        let model: Option<String> = conn.query_row("SELECT model FROM sessions WHERE id=?1", [session_id], |r| r.get(0)).ok().flatten();
        if let Some(model) = model.filter(|m| !m.trim().is_empty()) {
            for message in &mut messages {
                if message.role == "assistant" {
                    message.meta.get_or_insert_with(MessageMeta::default).model = Some(model.clone());
                }
            }
        }
    }
    Ok(messages)
}
fn messages_from_rows(
    rows: impl IntoIterator<Item = MessageRow>,
) -> Result<Vec<SessionMessage>, String> {
    let mut order: Vec<MessageRow> = Vec::new();
    let mut index: HashMap<DedupeKey, usize> = HashMap::new();
    for row in rows {
        if row.is_model_only() {
            continue;
        }
        match index.entry(row.dedupe_key()) {
            Entry::Occupied(slot) => {
                let kept = &mut order[*slot.get()];
                if (row.active, row.id) > (kept.active, kept.id) {
                    *kept = row;
                }
            }
            Entry::Vacant(slot) => {
                slot.insert(order.len());
                order.push(row);
            }
        }
    }
    let mut messages = Vec::new();
    for row in order {
        let ts = row.timestamp.and_then(timestamp_secs_to_ms);
        let raw_content = row.content.as_deref().unwrap_or_default();
        let text = decode_content(raw_content);
        let blocks = match row.role.as_str() {
            "tool" => {
                let plain = !raw_content.starts_with(CONTENT_JSON_PREFIX);
                vec![tool_result_block(
                    row.tool_call_id.clone().unwrap_or_default(),
                    ToolStatus::Unknown,
                    &text,
                    || plain.then(|| messages_cell(row.id, "content", String::new())),
                )]
            }
            "assistant" => {
                let mut blocks = Vec::new();
                if let Some(reasoning) = row.reasoning.as_deref().filter(|r| !r.trim().is_empty()) {
                    blocks.push(thinking_block(reasoning, None, None, || {
                        Some(messages_cell(row.id, "reasoning", String::new()))
                    }));
                }
                if !text.trim().is_empty() {
                    blocks.push(SessionBlock::text(text));
                }
                let calls = row
                    .tool_calls
                    .as_deref()
                    .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
                blocks.extend(openai_tool_calls(calls.as_ref(), |pointer| {
                    Some(messages_cell(row.id, "tool_calls", pointer))
                }));
                blocks
            }
            _ if text.trim().is_empty() => Vec::new(),
            _ => vec![SessionBlock::text(text)],
        };
        let mut message = SessionMessage::from_blocks(row.role.clone(), ts, blocks);
        if message.is_empty() {
            continue;
        }
        message.id = Some(row.id.to_string());
        if row.role == "assistant" {
            message.meta = Some(MessageMeta { stop_reason: row.finish_reason, ..Default::default() });
        }
        messages.push(message);
    }
    assign_turn_ids(&mut messages);
    Ok(messages)
}
/// `messages` 表某行某列的引用（`content::sqlite_allowed` 白名单内的列）
fn messages_cell(id: i64, column: &str, pointer: String) -> ContentRef {
    ContentRef::Sqlite {
        table: "messages".into(),
        id: id.to_string(),
        column: column.into(),
        pointer,
    }
}
/// Hermes stores timestamps as Unix epoch seconds (REAL).
fn timestamp_secs_to_ms(secs: f64) -> Option<i64> {
    (secs.is_finite() && secs > 0.0).then(|| (secs * 1000.0).round() as i64)
}
pub(crate) fn parse_sqlite_source(source: &str) -> Option<(PathBuf, String)> {
    let rest = source.strip_prefix("sqlite:")?;
    let hash_pos = rest.rfind('#')?;
    let db_path = PathBuf::from(&rest[..hash_pos]);
    let session_id = rest[hash_pos + 1..].to_string();
    if session_id.is_empty() {
        return None;
    }
    Some((db_path, session_id))
}
/// Load messages from a Hermes JSONL transcript file.
///
/// 字段名按 SQLite 同构推断（`tool_calls` / `tool_call_id`，待核实）。
pub fn load_messages(path: &Path) -> Result<Vec<SessionMessage>, String> {
    let mut messages = Vec::new();
    for_each_jsonl_value(path, |span, value| {
        let (msg, base, ts_val) = if value.get("type").and_then(Value::as_str) == Some("message") {
            let Some(msg) = value.get("message") else {
                return Ok(());
            };
            (
                msg,
                "/message",
                value.get("timestamp").or_else(|| msg.get("ts")),
            )
        } else {
            (
                &value,
                "",
                value.get("timestamp").or_else(|| value.get("ts")),
            )
        };
        let Some(role) = msg.get("role").and_then(Value::as_str) else {
            return Ok(());
        };
        let content = msg.get("content");
        let text = content.map(extract_text).unwrap_or_default();
        let content_ref = || {
            content
                .filter(|c| c.is_string())
                .map(|_| span.content_ref(format!("{base}/content")))
        };
        let blocks = match role {
            "tool" => {
                vec![tool_result_block(
                    msg.get("tool_call_id")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    ToolStatus::Unknown,
                    &text,
                    content_ref,
                )]
            }
            "assistant" => {
                let mut blocks = Vec::new();
                if !text.trim().is_empty() {
                    blocks.push(SessionBlock::text(text));
                }
                blocks.extend(openai_tool_calls(msg.get("tool_calls"), |pointer| {
                    Some(span.content_ref(format!("{base}/tool_calls{pointer}")))
                }));
                blocks
            }
            _ if text.trim().is_empty() => Vec::new(),
            _ => vec![SessionBlock::text(text)],
        };
        let ts = ts_val.and_then(parse_timestamp_to_ms);
        let mut message = SessionMessage::from_blocks(role, ts, blocks);
        message.id = msg.get("id").and_then(|id| id.as_str().map(str::to_string)
            .or_else(|| id.as_i64().map(|id| id.to_string())));
        if role == "assistant" {
            message.meta = Some(MessageMeta {
                stop_reason: msg.get("finish_reason").or_else(|| value.get("finish_reason"))
                    .and_then(Value::as_str).map(str::to_string),
                ..Default::default()
            });
        }
        if !message.is_empty() {
            messages.push(message);
        }
        Ok(())
    })?;
    assign_turn_ids(&mut messages);
    Ok(messages)
}
