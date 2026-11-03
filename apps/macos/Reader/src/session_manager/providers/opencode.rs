// Derived from CC Switch 4.0.21 (6d6b716); MIT, Copyright (c) 2025 Jason Young.
// Session reading only. See UPSTREAM.json and LICENSE.
#![allow(dead_code, unused_imports)]
use super::blocks::assign_turn_ids;
use super::opencode_blocks::{message_from_parts, PartLocator};
use super::utils::{parse_timestamp_to_ms, path_basename, truncate_summary};
use crate::session_manager::SessionMessage;
use rusqlite::Connection;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
/// OpenCode SQLite schema layout.
///
/// V1 uses `session` / `message` / `part` tables; V2 (OpenCode 2.x) migrates
/// sessions into `session_v2` / `session_message` and stops writing V1 tables.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpenCodeSchema {
    V1,
    V2,
}
fn detect_schema(conn: &Connection) -> OpenCodeSchema {
    if sqlite_table_exists(conn, "session_v2") && sqlite_table_exists(conn, "session_message") {
        OpenCodeSchema::V2
    } else {
        OpenCodeSchema::V1
    }
}
fn sqlite_table_exists(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get(0),
    )
    .unwrap_or(false)
}
/// Parse a SQLite source reference in the format `sqlite:<db_path>:<session_id>`.
///
/// Uses `rfind(":ses_")` to split the path from the session ID because the
/// db path itself may contain colons (e.g. `C:\Users\...` on Windows).
/// This relies on the OpenCode convention that session IDs start with `ses_`.
pub(crate) fn parse_sqlite_source(source: &str) -> Option<(PathBuf, String)> {
    let rest = source.strip_prefix("sqlite:")?;
    let sep = rest.rfind(":ses_")?;
    let db_path = PathBuf::from(&rest[..sep]);
    let session_id = rest[sep + 1..].to_string();
    Some((db_path, session_id))
}
pub fn load_messages(path: &Path) -> Result<Vec<SessionMessage>, String> {
    if !path.is_dir() {
        return Err(format!("Message directory not found: {}", path.display()));
    }
    let storage = path
        .parent()
        .and_then(|p| p.parent())
        .ok_or_else(|| "Cannot determine storage root from message path".to_string())?;
    let mut msg_files = Vec::new();
    collect_json_files(path, &mut msg_files);
    let mut entries: Vec<(i64, String, SessionMessage)> = Vec::new();
    for msg_path in &msg_files {
        let Some(value) = read_json(msg_path) else {
            continue;
        };
        let Some(msg_id) = value.get("id").and_then(Value::as_str) else {
            continue;
        };
        let role = value
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let created_ts = value
            .get("time")
            .and_then(|t| t.get("created"))
            .and_then(parse_timestamp_to_ms)
            .unwrap_or(0);
        let mut part_files = Vec::new();
        collect_json_files(&storage.join("part").join(msg_id), &mut part_files);
        part_files.sort();
        let parts: Vec<(PartLocator, Value)> = part_files
            .iter()
            .filter_map(|part_path| {
                let part = read_json(part_path)?;
                let rel_path = part_path
                    .strip_prefix(storage)
                    .ok()?
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/");
                Some((PartLocator::File { rel_path }, part))
            })
            .collect();
        let ts = (created_ts > 0).then_some(created_ts);
        let message = message_from_parts(role, Some(msg_id.to_string()), ts, &value, &parts);
        if message.is_empty() {
            continue;
        }
        entries.push((created_ts, msg_id.to_string(), message));
    }
    entries.sort_by(|a, b| (a.0, &a.1).cmp(&(b.0, &b.1)));
    let mut messages: Vec<SessionMessage> = entries.into_iter().map(|(_, _, m)| m).collect();
    assign_turn_ids(&mut messages);
    Ok(messages)
}
fn read_json(path: &Path) -> Option<Value> {
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}
/// Load messages from the OpenCode SQLite database for a given source reference.
///
/// Supports both V1 (`message` + `part` tables) and V2 (`session_message` table).
pub fn load_messages_sqlite(source: &str) -> Result<Vec<SessionMessage>, String> {
    let (db_path, session_id) = parse_sqlite_source(source)
        .ok_or_else(|| format!("Invalid SQLite source reference: {source}"))?;
    let conn = Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("Failed to open OpenCode database: {e}"))?;
    let schema = detect_schema(&conn);
    match schema {
        OpenCodeSchema::V1 => load_messages_sqlite_v1(&conn, &session_id),
        OpenCodeSchema::V2 => {
            let in_session_v2 = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM session_v2 WHERE id = ?1)",
                    [&session_id],
                    |row| row.get(0),
                )
                .unwrap_or(false);
            if in_session_v2 {
                load_messages_sqlite_v2(&conn, &session_id)
            } else if sqlite_table_exists(&conn, "message") {
                load_messages_sqlite_v1(&conn, &session_id)
            } else {
                load_messages_sqlite_v2(&conn, &session_id)
            }
        }
    }
}
fn load_messages_sqlite_v1(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<SessionMessage>, String> {
    let mut msg_stmt = conn
        .prepare(
            "SELECT id, time_created, data FROM message WHERE session_id = ?1 \
             ORDER BY time_created ASC, id ASC",
        )
        .map_err(|e| format!("Failed to prepare message query: {e}"))?;
    let msg_rows = msg_stmt
        .query_map([session_id], |row| {
            let id: String = row.get(0)?;
            let ts: i64 = row.get(1)?;
            let data: String = row.get(2)?;
            Ok((id, ts, data))
        })
        .map_err(|e| format!("Failed to query messages: {e}"))?;
    let mut part_stmt = conn
        .prepare(
            "SELECT id, message_id, data FROM part WHERE session_id = ?1 \
             ORDER BY time_created ASC, id ASC",
        )
        .map_err(|e| format!("Failed to prepare part query: {e}"))?;
    let part_rows = part_stmt
        .query_map([session_id], |row| {
            let part_id: String = row.get(0)?;
            let message_id: String = row.get(1)?;
            let data: String = row.get(2)?;
            Ok((part_id, message_id, data))
        })
        .map_err(|e| format!("Failed to query parts: {e}"))?;
    let mut parts_map: HashMap<String, Vec<(PartLocator, Value)>> = HashMap::new();
    for (part_id, message_id, data) in part_rows.flatten() {
        let Ok(part) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        let locator = PartLocator::Sqlite {
            table: "part",
            id: part_id,
            base: String::new(),
        };
        parts_map
            .entry(message_id)
            .or_default()
            .push((locator, part));
    }
    let mut messages = Vec::new();
    for (msg_id, ts, data) in msg_rows.flatten() {
        let Ok(msg_value) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        let role = msg_value
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let parts = parts_map.remove(&msg_id).unwrap_or_default();
        let message = message_from_parts(role, Some(msg_id), Some(ts), &msg_value, &parts);
        if !message.is_empty() {
            messages.push(message);
        }
    }
    assign_turn_ids(&mut messages);
    Ok(messages)
}
fn load_messages_sqlite_v2(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<SessionMessage>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, type, time_created, data \
             FROM session_message \
             WHERE session_id = ?1 \
             ORDER BY seq ASC, rowid ASC",
        )
        .map_err(|e| format!("Failed to prepare V2 message query: {e}"))?;
    let rows = stmt
        .query_map([session_id], |row| {
            let id: String = row.get(0)?;
            let msg_type: String = row.get(1)?;
            let ts: i64 = row.get(2)?;
            let data: String = row.get(3)?;
            Ok((id, msg_type, ts, data))
        })
        .map_err(|e| format!("Failed to query V2 messages: {e}"))?;
    let mut messages = Vec::new();
    for (row_id, msg_type, ts, data) in rows.flatten() {
        let Ok(msg_value) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        if !matches!(msg_type.as_str(), "user" | "assistant" | "system") {
            continue;
        }
        let text_part = |text: &str| {
            (
                PartLocator::Sqlite {
                    table: "session_message",
                    id: row_id.clone(),
                    base: String::new(),
                },
                serde_json::json!({ "type" : "text", "text" : text }),
            )
        };
        let parts: Vec<(PartLocator, Value)> = match (
            msg_type.as_str(),
            msg_value.get("text").and_then(Value::as_str),
            msg_value.get("content"),
        ) {
            ("user" | "system", Some(text), _) => vec![text_part(text)],
            (_, _, Some(Value::Array(items))) if msg_type != "system" => items
                .iter()
                .enumerate()
                .map(|(i, item)| {
                    (
                        PartLocator::Sqlite {
                            table: "session_message",
                            id: row_id.clone(),
                            base: format!("/content/{i}"),
                        },
                        item.clone(),
                    )
                })
                .collect(),
            (_, _, Some(Value::String(text))) if msg_type == "user" => {
                vec![text_part(text)]
            }
            (_, Some(text), _) => vec![text_part(text)],
            _ => Vec::new(),
        };
        let message = message_from_parts(
            &msg_type,
            Some(row_id.clone()),
            Some(ts),
            &msg_value,
            &parts,
        );
        if !message.is_empty() {
            messages.push(message);
        }
    }
    assign_turn_ids(&mut messages);
    Ok(messages)
}
fn collect_json_files(root: &Path, files: &mut Vec<PathBuf>) {
    if !root.exists() {
        return;
    }
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_json_files(&path, files);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("json") {
            files.push(path);
        }
    }
}
