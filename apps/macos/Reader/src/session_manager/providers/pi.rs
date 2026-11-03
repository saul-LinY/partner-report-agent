// Derived from CC Switch 4.0.21 (6d6b716); MIT, Copyright (c) 2025 Jason Young.
// Session reading only. See UPSTREAM.json and LICENSE.
#![allow(dead_code, unused_imports)]
use super::pi_blocks::PiTranscript;
use super::utils::for_each_jsonl_value;
use super::utils::{
    extract_text, parse_timestamp_to_ms, path_basename, truncate_summary, TITLE_MAX_CHARS,
};
use crate::session_manager::SessionMessage;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
const PROVIDER_ID: &str = "pi";
pub(crate) const MAX_TREE_ENTRIES: usize = 500_000;
const MAX_TREE_ID_BYTES: usize = 256;
pub(crate) const MAX_SESSION_BYTES: u64 = 128 * 1024 * 1024;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SessionLayout {
    Flat,
    ProjectDirectories,
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SessionRootResolution {
    Available {
        root: PathBuf,
        layout: SessionLayout,
    },
    RequiresProjectContext {
        configured_path: String,
    },
    Unavailable {
        reason: String,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PiSessionDiscovery {
    Available,
    RequiresProjectContext {
        #[serde(rename = "configuredPath")]
        configured_path: String,
    },
    Unavailable {
        reason: String,
    },
}
/// Pi 和它的分支 Oh My Pi 的会话格式只差这几处，会话树、活动分支和转录块共用这里的实现。
pub(crate) struct Dialect {
    pub provider_id: &'static str,
    /// 报错和日志里的应用名
    pub label: &'static str,
    pub resolve_root: fn() -> SessionRootResolution,
    /// Oh My Pi：首行可能是定宽的 `{"type":"title"}` 标题槽，会话头里也可能带 `title`
    pub title_slot: bool,
    /// Oh My Pi 的 `model_change` 只写 `provider/id` 一个串，Pi 拆成 `provider` + `modelId`
    pub model_selector: bool,
}
const PI: Dialect = Dialect {
    provider_id: PROVIDER_ID,
    label: "Pi",
    resolve_root: resolve_session_root,
    title_slot: false,
    model_selector: false,
};
#[derive(Debug)]
struct SessionHeader {
    id: String,
    cwd: String,
    timestamp: Option<i64>,
    version: u64,
    title: Option<String>,
}
#[derive(Debug)]
struct SessionTree {
    header: SessionHeader,
    active_entry_indexes: HashSet<usize>,
    summary: SessionSummary,
}
#[derive(Debug, Default)]
struct SessionSummary {
    first_user_message: Option<String>,
    last_message: Option<String>,
    explicit_name: Option<Option<String>>,
    last_active_at: Option<i64>,
}
fn resolve_session_root() -> SessionRootResolution {
    let home = crate::config::get_home_dir();
    if let Some(raw) = std::env::var_os("PI_CODING_AGENT_SESSION_DIR") {
        if !raw.is_empty() {
            return classify_configured_session_dir(
                raw.to_string_lossy().as_ref(),
                &home,
                "environment",
            );
        }
    }
    match crate::pi_config::read_pi_native_defaults() {
        Ok(defaults) => {
            if let Some(value) = defaults.session_dir.filter(|value| !value.is_empty()) {
                return classify_configured_session_dir(&value, &home, "settings");
            }
        }
        Err(error) => {
            return SessionRootResolution::Unavailable {
                reason: error.to_string(),
            };
        }
    }
    match crate::pi_config::get_pi_agent_dir() {
        Ok(agent_dir) => SessionRootResolution::Available {
            root: agent_dir.join("sessions"),
            layout: SessionLayout::ProjectDirectories,
        },
        Err(error) => SessionRootResolution::Unavailable {
            reason: error.to_string(),
        },
    }
}
fn classify_configured_session_dir(
    value: &str,
    home: &Path,
    source: &'static str,
) -> SessionRootResolution {
    match resolve_global_session_dir(value, home) {
        Some(root) => {
            match fs::metadata(&root) {
                Ok(metadata) if !metadata.is_dir() => {
                    SessionRootResolution::Unavailable {
                        reason: format!(
                            "Configured Pi session directory from {source} is not a directory: {}",
                            root.display()
                        ),
                    }
                }
                Ok(_) => {
                    match fs::read_dir(&root) {
                        Ok(_) => {
                            SessionRootResolution::Available {
                                root,
                                layout: SessionLayout::Flat,
                            }
                        }
                        Err(error) => {
                            SessionRootResolution::Unavailable {
                                reason: format!(
                                    "Configured Pi session directory from {source} is not readable ({}): {error}",
                                    root.display()
                                ),
                            }
                        }
                    }
                }
                Err(error) => {
                    SessionRootResolution::Unavailable {
                        reason: format!(
                            "Configured Pi session directory from {source} is unavailable ({}): {error}",
                            root.display()
                        ),
                    }
                }
            }
        }
        None => {
            SessionRootResolution::RequiresProjectContext {
                configured_path: value.to_string(),
            }
        }
    }
}
fn resolve_global_session_dir(value: &str, home: &Path) -> Option<PathBuf> {
    let path = if value == "~" {
        home.to_path_buf()
    } else if let Some(suffix) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        home.join(suffix)
    } else {
        PathBuf::from(value)
    };
    path.is_absolute().then_some(path)
}
pub fn load_messages(path: &Path) -> Result<Vec<SessionMessage>, String> {
    load_messages_for(&PI, path)
}
pub(crate) fn load_messages_for(d: &Dialect, path: &Path) -> Result<Vec<SessionMessage>, String> {
    let (root, layout) = available_root(d)?;
    load_messages_with_layout(d, &root, path, layout)
}
fn load_messages_with_layout(
    d: &Dialect,
    root: &Path,
    path: &Path,
    layout: SessionLayout,
) -> Result<Vec<SessionMessage>, String> {
    let (_, source) = validate_source_under_root(d, root, path, layout)?;
    let tree = read_tree(d, &source)?;
    read_active_messages(d, &source, &tree)
}
fn available_root(d: &Dialect) -> Result<(PathBuf, SessionLayout), String> {
    match (d.resolve_root)() {
        SessionRootResolution::Available { root, layout } => Ok((root, layout)),
        SessionRootResolution::RequiresProjectContext { .. } => Err(format!(
            "Relative {} session directory cannot be globally resolved",
            d.label
        )),
        SessionRootResolution::Unavailable { reason } => Err(reason),
    }
}
fn read_tree(d: &Dialect, path: &Path) -> Result<SessionTree, String> {
    let label = d.label;
    validate_file_size(d, path)?;
    let mut reader = BufReader::new(
        File::open(path).map_err(|error| format!("Failed to open {label} session: {error}"))?,
    );
    let mut header = None;
    let mut parents = HashMap::<String, (Option<String>, usize)>::new();
    let mut latest_id = None;
    let mut legacy_previous_id = None;
    let mut entry_index = 0usize;
    let mut summary = SessionSummary::default();
    let mut line = Vec::new();
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line).map_err(|error| format!("Failed to read {label} session: {error}"))? == 0 { break; }
        // Match the byte-based message parser when a writer is halfway through
        // a UTF-8 character in the incomplete final record.
        let Ok(value) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        if header.is_none() {
            if d.title_slot && value.get("type").and_then(Value::as_str) == Some("title") {
                summary.explicit_name = Some(non_empty_text(value.get("title")));
                continue;
            }
            let parsed = parse_header(d, &value)?;
            if summary.explicit_name.is_none() && parsed.title.is_some() {
                summary.explicit_name = Some(parsed.title.clone());
            }
            header = Some(parsed);
            continue;
        }
        entry_index += 1;
        if entry_index > MAX_TREE_ENTRIES {
            return Err(format!(
                "{label} session exceeds the {MAX_TREE_ENTRIES}-entry safety limit"
            ));
        }
        update_session_summary(&mut summary, &value);
        let version = header
            .as_ref()
            .map_or(1, |item: &SessionHeader| item.version);
        let Some((id, parent_id)) =
            entry_identity(&value, version, entry_index, legacy_previous_id.as_deref())
        else {
            continue;
        };
        if parents
            .insert(id.clone(), (parent_id, entry_index))
            .is_some()
        {
            log::debug!("{label} session contains duplicate entry ID {id}; using the latest entry");
        }
        latest_id = Some(id.clone());
        legacy_previous_id = Some(id);
    }
    let header = header.ok_or_else(|| format!("{label} session has no valid header"))?;
    let mut active_entry_indexes = HashSet::new();
    let mut visited_ids = HashSet::new();
    let mut current = latest_id;
    while let Some(id) = current {
        if !visited_ids.insert(id.clone()) {
            log::debug!("{label} session tree contains a cycle at entry {id}; stopping traversal");
            break;
        }
        let Some((parent_id, entry_index)) = parents.get(&id) else {
            log::debug!("{label} session tree references missing entry {id}; stopping traversal");
            break;
        };
        active_entry_indexes.insert(*entry_index);
        current = parent_id.clone();
    }
    Ok(SessionTree {
        header,
        active_entry_indexes,
        summary,
    })
}
fn update_session_summary(summary: &mut SessionSummary, value: &Value) {
    if value.get("type").and_then(Value::as_str) == Some("session_info") {
        summary.explicit_name = Some(non_empty_text(value.get("name")));
        return;
    }
    let Some((role, content)) = value
        .get("message")
        .filter(|_| value.get("type").and_then(Value::as_str) == Some("message"))
        .and_then(parse_message)
    else {
        return;
    };
    if !matches!(role.as_str(), "user" | "assistant") {
        return;
    }
    let timestamp = value
        .get("message")
        .and_then(|message| message.get("timestamp"))
        .and_then(parse_timestamp_to_ms)
        .or_else(|| value.get("timestamp").and_then(parse_timestamp_to_ms));
    if let Some(timestamp) = timestamp {
        summary.last_active_at = Some(
            summary
                .last_active_at
                .map_or(timestamp, |current| current.max(timestamp)),
        );
    }
    if role == "user" && summary.first_user_message.is_none() {
        summary.first_user_message = Some(content.clone());
    }
    summary.last_message = Some(content);
}
fn non_empty_text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}
fn read_active_messages(
    d: &Dialect,
    path: &Path,
    tree: &SessionTree,
) -> Result<Vec<SessionMessage>, String> {
    let label = d.label;
    validate_file_size(d, path)?;
    let mut transcript = PiTranscript::new();
    let mut saw_header = false;
    let mut entry_index = 0usize;
    let mut legacy_previous_id = None;
    for_each_jsonl_value(path, |span, mut value| {
        if !saw_header {
            if value.get("type").and_then(Value::as_str) == Some("session") {
                saw_header = true;
            }
            return Ok(());
        }
        entry_index += 1;
        if entry_index > MAX_TREE_ENTRIES {
            return Err(format!(
                "{label} session exceeds the {MAX_TREE_ENTRIES}-entry safety limit"
            ));
        }
        let Some((id, _)) = entry_identity(
            &value,
            tree.header.version,
            entry_index,
            legacy_previous_id.as_deref(),
        ) else {
            return Ok(());
        };
        legacy_previous_id = Some(id.clone());
        if tree.active_entry_indexes.contains(&entry_index) {
            if d.model_selector {
                split_model_selector(&mut value);
            }
            transcript.push_entry(&value, span, Some(id));
        }
        Ok(())
    })
    .map_err(|error| error.replace("session file", &format!("{label} session")))?;
    Ok(transcript.finish())
}
/// Oh My Pi 的模型串是 `provider/id`，转录块按 Pi 的 `provider` + `modelId` 读。
fn split_model_selector(value: &mut Value) {
    if value.get("type").and_then(Value::as_str) != Some("model_change") {
        return;
    }
    let Some(model) = value
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return;
    };
    match model.split_once('/') {
        Some((provider, model_id)) => {
            value["provider"] = Value::String(provider.to_string());
            value["modelId"] = Value::String(model_id.to_string());
        }
        None => value["modelId"] = Value::String(model),
    }
}
fn parse_header(d: &Dialect, value: &Value) -> Result<SessionHeader, String> {
    let label = d.label;
    if value.get("type").and_then(Value::as_str) != Some("session") {
        return Err(format!(
            "{label} session header must be the first valid JSON entry"
        ));
    }
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| is_valid_tree_id(id))
        .ok_or_else(|| format!("{label} session header has an invalid ID"))?
        .to_string();
    let version = value.get("version").and_then(Value::as_u64).unwrap_or(1);
    if version == 0 {
        return Err(format!("Unsupported {label} session version: {version}"));
    }
    Ok(SessionHeader {
        id,
        cwd: value
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        timestamp: value.get("timestamp").and_then(parse_timestamp_to_ms),
        version,
        title: d
            .title_slot
            .then(|| non_empty_text(value.get("title")))
            .flatten(),
    })
}
fn entry_identity(
    value: &Value,
    version: u64,
    entry_index: usize,
    legacy_previous_id: Option<&str>,
) -> Option<(String, Option<String>)> {
    if version < 2 {
        return Some((
            format!("legacy-{entry_index}"),
            legacy_previous_id.map(str::to_string),
        ));
    }
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| is_valid_tree_id(id))?
        .to_string();
    let parent_id = match value.get("parentId") {
        None | Some(Value::Null) => None,
        Some(Value::String(parent)) if is_valid_tree_id(parent) => Some(parent.clone()),
        _ => return None,
    };
    Some((id, parent_id))
}
fn parse_message(message: &Value) -> Option<(String, String)> {
    let role = message.get("role").and_then(Value::as_str)?;
    let (display_role, content) = match role {
        "user" | "assistant" => (
            role.to_string(),
            message.get("content").map(extract_text).unwrap_or_default(),
        ),
        "toolResult" => (
            "tool".to_string(),
            message.get("content").map(extract_text).unwrap_or_default(),
        ),
        "bashExecution" => (
            "tool".to_string(),
            format!(
                "$ {}\n{}",
                message
                    .get("command")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                message
                    .get("output")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            ),
        ),
        "branchSummary" | "compactionSummary" => (
            "system".to_string(),
            message
                .get("summary")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        ),
        _ => return None,
    };
    (!content.trim().is_empty()).then_some((display_role, content))
}
fn validate_source_under_root(
    d: &Dialect,
    root: &Path,
    path: &Path,
    layout: SessionLayout,
) -> Result<(PathBuf, PathBuf), String> {
    let label = d.label;
    let root = root.canonicalize().map_err(|error| {
        format!(
            "Failed to resolve {label} session root {}: {error}",
            root.display()
        )
    })?;
    let source = path.canonicalize().map_err(|error| {
        format!(
            "Failed to resolve {label} session {}: {error}",
            path.display()
        )
    })?;
    if !source.starts_with(&root) {
        return Err(format!(
            "{label} session source is outside the session root: {}",
            path.display()
        ));
    }
    if !matches_session_layout(&root, &source, layout) {
        return Err(format!(
            "{label} session source does not match the active directory layout: {}",
            path.display()
        ));
    }
    let metadata = fs::symlink_metadata(&source).map_err(|error| {
        format!(
            "Failed to inspect {label} session {}: {error}",
            source.display()
        )
    })?;
    if !metadata.file_type().is_file()
        || source.extension().and_then(|value| value.to_str()) != Some("jsonl")
        || metadata.len() > MAX_SESSION_BYTES
    {
        return Err(format!(
            "Invalid {label} session file: {}",
            source.display()
        ));
    }
    Ok((root, source))
}
fn matches_session_layout(root: &Path, source: &Path, layout: SessionLayout) -> bool {
    let Ok(relative) = source.strip_prefix(root) else {
        return false;
    };
    let depth = relative.components().count();
    match layout {
        SessionLayout::Flat => depth == 1,
        SessionLayout::ProjectDirectories => depth == 2,
    }
}
fn validate_file_size(d: &Dialect, path: &Path) -> Result<(), String> {
    let label = d.label;
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Failed to inspect {label} session: {error}"))?;
    if metadata.len() > MAX_SESSION_BYTES {
        Err(format!(
            "{label} session exceeds the {MAX_SESSION_BYTES}-byte safety limit"
        ))
    } else {
        Ok(())
    }
}
pub(crate) fn is_valid_tree_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_TREE_ID_BYTES
        && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}
