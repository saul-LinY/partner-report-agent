// Derived from CC Switch 4.0.21 (6d6b716); MIT, Copyright (c) 2025 Jason Young.
// Session reading only. See UPSTREAM.json and LICENSE.
#![allow(dead_code, unused_imports)]
use super::blocks::{
    assign_turn_ids, estimate_base64_size, first_string_field, large_text_block,
    line_change_counts, normalize_tool, one_line_title, preview, preview_chars, refine_shell_kind,
    split_mcp_name, summary_event_block, title_agent, title_ask, title_mcp, title_other,
    title_path, title_read, title_search, title_shell, title_todo, title_web, NormalizedTool,
    ToolSource, INPUT_PREVIEW_CHARS, THINKING_PREVIEW_CHARS,
};
use super::utils::{
    extract_text, parse_timestamp_to_ms, path_basename, read_head_tail_lines, truncate_summary,
    JsonlSpan, LineSpans, TITLE_MAX_CHARS,
};
use crate::session_manager::model::{
    ContentRef, DiffFile, DiffOp, DiffSummary, EventKind, ImageRef, ImageSource, MessageMeta,
    SessionBlock, ToolKind, ToolStatus,
};
use crate::session_manager::SessionMessage;
use serde::de::{self, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::Deserialize;
use serde_json::Value;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
pub fn load_messages(path: &Path) -> Result<Vec<SessionMessage>, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open session file: {e}"))?;
    let mut lines = LineSpans::new(BufReader::with_capacity(256 * 1024, file));
    let mut builder = TranscriptBuilder::new(path.with_extension(""));
    while let Ok(Some(span)) = lines.next_line() {
        if span.bytes.is_empty() {
            continue;
        }
        let record: RawRecord = match serde_json::from_slice(span.bytes) {
            Ok(record) => record,
            Err(_) => continue,
        };
        builder.push(record, span.span);
    }
    Ok(builder.finish())
}
/// 解析中的消息；全部记录处理完后再统一投影出 `content`（结果记录会回填前面的 ToolCall）。
struct Draft {
    role: String,
    ts: Option<i64>,
    id: Option<String>,
    injected: bool,
    blocks: Vec<SessionBlock>,
    meta: Option<MessageMeta>,
    /// assistant 的 API `message.id`：Claude Code 把一次回复按内容块拆成多条记录，
    /// 同 id 的相邻记录合并成一条消息
    api_id: Option<String>,
}
/// 已见过的 tool_use 在 `drafts` 中的位置，供结果记录配对与回填。
struct CallSlot {
    draft: usize,
    block: usize,
    ts: Option<i64>,
    name: String,
}
struct TranscriptBuilder {
    /// 会话附属目录 `<sessionId>/`（tool-results 等落盘文件）
    sidecar_dir: PathBuf,
    drafts: Vec<Draft>,
    calls: HashMap<String, CallSlot>,
    /// pr-link 会在每轮结束时重复写入，同一个 URL 只出一次
    pr_urls: HashSet<String>,
}
impl TranscriptBuilder {
    fn new(sidecar_dir: PathBuf) -> Self {
        Self {
            sidecar_dir,
            drafts: Vec::new(),
            calls: HashMap::new(),
            pr_urls: HashSet::new(),
        }
    }
    fn finish(self) -> Vec<SessionMessage> {
        let mut messages: Vec<SessionMessage> = self
            .drafts
            .into_iter()
            .map(|draft| {
                let mut message = SessionMessage::from_blocks(draft.role, draft.ts, draft.blocks);
                message.id = draft.id;
                message.injected = draft.injected;
                message.meta = draft.meta;
                message
            })
            .filter(|message| !message.is_empty())
            .collect();
        assign_turn_ids(&mut messages);
        messages
    }
    fn push(&mut self, record: RawRecord<'_>, line: JsonlSpan) {
        if is_true(&record.is_sidechain) || is_true(&record.is_meta) {
            return;
        }
        let ts = record.timestamp.as_ref().and_then(parse_timestamp_to_ms);
        match record.kind.as_str() {
            Some("system") => self.push_system(&record, ts, line),
            Some("pr-link") => self.push_pr_link(&record, ts),
            Some("user") | Some("assistant") | None => {
                let kind = record.kind.as_str().map(str::to_string);
                let uuid = record.uuid.as_str().map(str::to_string);
                let thinking_ms = record.thinking_duration_ms.as_ref().and_then(as_u64);
                let compact_summary = is_true(&record.is_compact_summary);
                let tool_use_result = record.tool_use_result.0;
                let Some(message) = record.message.0 else {
                    return;
                };
                let role = message
                    .role
                    .as_str()
                    .map(str::to_string)
                    .or(kind)
                    .unwrap_or_else(|| "unknown".to_string());
                if compact_summary {
                    self.push_compact_summary(message.content, ts, line);
                } else if role == "user" {
                    self.push_user(message.content, tool_use_result, uuid, ts, line);
                } else {
                    self.push_assistant(role, message, uuid, thinking_ms, ts, line);
                }
            }
            _ => {}
        }
    }
    fn push_draft(
        &mut self,
        role: &str,
        ts: Option<i64>,
        id: Option<String>,
        blocks: Vec<SessionBlock>,
    ) {
        self.drafts.push(Draft {
            role: role.to_string(),
            ts,
            id,
            injected: false,
            blocks,
            meta: None,
            api_id: None,
        });
    }
    fn push_event(
        &mut self,
        ts: Option<i64>,
        kind: EventKind,
        text: Option<String>,
        url: Option<String>,
    ) {
        self.push_draft(
            "system",
            ts,
            None,
            vec![SessionBlock::event(kind, text, url)],
        );
    }
    fn push_system(&mut self, record: &RawRecord<'_>, ts: Option<i64>, line: JsonlSpan) {
        match record.subtype.as_str() {
            Some("stop_hook_summary") => {
                let errors: Vec<String> = match &record.hook_errors {
                    Some(Value::Array(items)) => items
                        .iter()
                        .map(|item| match item {
                            Value::String(s) => s.trim().to_string(),
                            other => other.to_string(),
                        })
                        .filter(|s| !s.is_empty())
                        .collect(),
                    _ => Vec::new(),
                };
                if !errors.is_empty() {
                    self.push_event(ts, EventKind::Hook, Some(errors.join("\n")), None);
                }
            }
            Some("compact_boundary") => {
                let text = record
                    .content
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Conversation compacted");
                self.push_event(ts, EventKind::Compaction, Some(text.to_string()), None);
            }
            Some("local_command") => {
                if let Some(content) = record.content.as_str() {
                    let uuid = record.uuid.as_str().map(str::to_string);
                    self.push_user_texts(
                        vec![(Cow::Borrowed(content), line.content_ref("/content"))],
                        Vec::new(),
                        Vec::new(),
                        uuid,
                        ts,
                    );
                }
            }
            _ => {}
        }
    }
    fn push_pr_link(&mut self, record: &RawRecord<'_>, ts: Option<i64>) {
        let Some(url) = record.pr_url.as_str().filter(|u| !u.trim().is_empty()) else {
            return;
        };
        if !self.pr_urls.insert(url.to_string()) {
            return;
        }
        let text = match record.pr_number.as_ref() {
            Some(Value::Number(n)) => format!("PR #{n}"),
            Some(Value::String(s)) if !s.is_empty() => format!("PR #{s}"),
            _ => "PR".to_string(),
        };
        self.push_event(ts, EventKind::PrLink, Some(text), Some(url.to_string()));
    }
    /// `/compact` 之后的摘要记录：并入紧邻的 compact_boundary 事件，没有则单独成一条。
    /// 摘要通常有数 KB，只放预览，全文按 `/message/content` 引用取。
    fn push_compact_summary(&mut self, content: RawContent<'_>, ts: Option<i64>, line: JsonlSpan) {
        let summary = content_text(&content);
        if summary.trim().is_empty() {
            return;
        }
        let block = summary_event_block(EventKind::Compaction, &summary, || {
            Some(line.content_ref("/message/content"))
        });
        if let Some(last) = self.drafts.last_mut() {
            if let [event @ SessionBlock::Event {
                kind: EventKind::Compaction,
                ..
            }] = last.blocks.as_mut_slice()
            {
                *event = block;
                return;
            }
        }
        self.push_draft("system", ts, None, vec![block]);
    }
    fn push_assistant(
        &mut self,
        role: String,
        message: RawMessage<'_>,
        uuid: Option<String>,
        thinking_ms: Option<u64>,
        ts: Option<i64>,
        line: JsonlSpan,
    ) {
        let mut blocks = Vec::new();
        let mut calls: Vec<(usize, String, String)> = Vec::new();
        match message.content {
            RawContent::Text(text) => {
                if !text.trim().is_empty() {
                    blocks.push(SessionBlock::text(text.into_owned()));
                }
            }
            RawContent::Items(items) => {
                for (i, item) in items.into_iter().enumerate() {
                    let Some(item) = item.0 else { continue };
                    match item.kind.as_str().unwrap_or_default() {
                        "text" => {
                            if let Some(text) = item.text.0.filter(|t| !t.trim().is_empty()) {
                                blocks.push(SessionBlock::text(text.into_owned()));
                            }
                        }
                        kind @ ("thinking" | "redacted_thinking") => {
                            if let Some(block) = thinking_block(&item, kind, i, thinking_ms, line) {
                                blocks.push(block);
                            }
                        }
                        "tool_use" | "server_tool_use" => {
                            let block = tool_call_block(item, i, line);
                            if let SessionBlock::ToolCall { id, raw_name, .. } = &block {
                                if !id.is_empty() {
                                    calls.push((blocks.len(), id.clone(), raw_name.clone()));
                                }
                            }
                            blocks.push(block);
                        }
                        _ => {}
                    }
                }
            }
            RawContent::None => {}
        }
        if blocks.is_empty() {
            return;
        }
        let meta = message_meta(&message.model, message.usage.as_ref(), &message.stop_reason);
        let api_id = message.id.as_str().map(str::to_string);
        let mergeable = self
            .drafts
            .last()
            .is_some_and(|last| last.role == role && api_id.is_some() && last.api_id == api_id);
        let (draft, base) = if mergeable {
            let last = self.drafts.last_mut().expect("checked above");
            let base = last.blocks.len();
            last.blocks.extend(blocks);
            merge_meta(&mut last.meta, meta);
            (self.drafts.len() - 1, base)
        } else {
            self.drafts.push(Draft {
                role,
                ts,
                id: uuid,
                injected: false,
                blocks,
                meta,
                api_id,
            });
            (self.drafts.len() - 1, 0)
        };
        for (index, id, name) in calls {
            self.calls.insert(
                id,
                CallSlot {
                    draft,
                    block: base + index,
                    ts,
                    name,
                },
            );
        }
    }
    fn push_user(
        &mut self,
        content: RawContent<'_>,
        tool_use_result: Option<ToolUseResult>,
        uuid: Option<String>,
        ts: Option<i64>,
        line: JsonlSpan,
    ) {
        let mut results = Vec::new();
        let mut texts = Vec::new();
        let mut images = Vec::new();
        match content {
            RawContent::Text(text) => texts.push((text, line.content_ref("/message/content"))),
            RawContent::Items(items) => {
                let result_count = items
                    .iter()
                    .filter(|item| {
                        item.0
                            .as_ref()
                            .is_some_and(|i| i.kind.as_str() == Some("tool_result"))
                    })
                    .count();
                let tool_use_result = tool_use_result.filter(|_| result_count == 1);
                for (i, item) in items.into_iter().enumerate() {
                    let Some(item) = item.0 else { continue };
                    match item.kind.as_str().unwrap_or_default() {
                        "tool_result" => results.push(self.tool_result_block(
                            item,
                            i,
                            tool_use_result.as_ref(),
                            ts,
                            line,
                        )),
                        "text" => {
                            if let Some(text) = item.text.0 {
                                texts.push((
                                    text,
                                    line.content_ref(format!("/message/content/{i}/text")),
                                ));
                            }
                        }
                        "image" => {
                            if let Some(image) = image_ref(
                                item.source.0.as_ref(),
                                format!("/message/content/{i}/source/data"),
                                line,
                            ) {
                                images.push(SessionBlock::Image { image });
                            }
                        }
                        _ => {}
                    }
                }
            }
            RawContent::None => {}
        }
        self.push_user_texts(texts, results, images, uuid, ts);
    }
    /// 按 §4.1 给用户文本归类：中断 / 斜杠命令 / `!` 命令 / 注入内容 / 普通提问。
    /// `texts` 每项带上它在源记录里的引用，超长注入文本只放预览 + 引用。
    fn push_user_texts(
        &mut self,
        texts: Vec<(Cow<'_, str>, ContentRef)>,
        mut blocks: Vec<SessionBlock>,
        images: Vec<SessionBlock>,
        uuid: Option<String>,
        ts: Option<i64>,
    ) {
        let has_results = !blocks.is_empty();
        let mut injected = false;
        let injected_blocks = |texts: &[(Cow<'_, str>, ContentRef)]| -> Vec<SessionBlock> {
            texts
                .iter()
                .map(|(text, full)| large_text_block(text.to_string(), || Some(full.clone())))
                .collect()
        };
        if let Some(first) = texts.iter().map(|(t, _)| t.trim()).find(|t| !t.is_empty()) {
            if first.starts_with("[Request interrupted by user") {
                blocks.push(SessionBlock::event(
                    EventKind::Aborted,
                    Some(first.to_string()),
                    None,
                ));
            } else if let Some(command) = slash_command(first) {
                blocks.push(SessionBlock::event(
                    EventKind::SlashCommand,
                    Some(command),
                    None,
                ));
            } else if first.starts_with("<bash-input>") {
                blocks.extend(user_bash_blocks(first, uuid.as_deref()));
            } else if is_injected_text(first) {
                if !has_results {
                    injected = true;
                    blocks.extend(injected_blocks(&texts));
                }
            } else {
                let stripped: Vec<String> = texts
                    .iter()
                    .map(|(t, _)| strip_system_reminders(t))
                    .filter(|t| !t.trim().is_empty())
                    .collect();
                if !stripped.is_empty() {
                    blocks.extend(stripped.into_iter().map(SessionBlock::text));
                } else if !has_results && images.is_empty() {
                    injected = true;
                    blocks.extend(injected_blocks(&texts));
                }
            }
        }
        blocks.extend(images);
        if blocks.is_empty() {
            return;
        }
        let all_results = blocks
            .iter()
            .all(|b| matches!(b, SessionBlock::ToolResult { .. }));
        let role = if all_results { "tool" } else { "user" };
        self.push_draft(role, ts, uuid, blocks);
        if let Some(last) = self.drafts.last_mut() {
            last.injected = injected;
        }
    }
    fn tool_result_block(
        &mut self,
        item: RawItem<'_>,
        index: usize,
        tool_use_result: Option<&ToolUseResult>,
        ts: Option<i64>,
        line: JsonlSpan,
    ) -> SessionBlock {
        let call_id = item.tool_use_id.as_str().unwrap_or_default().to_string();
        let base = format!("/message/content/{index}/content");
        let mut images = Vec::new();
        let (text, pointer): (Cow<'_, str>, Option<String>) = match item.content {
            RawContent::Text(text) => (text, Some(base)),
            RawContent::Items(parts) => {
                let mut texts: Vec<(usize, Cow<'_, str>)> = Vec::new();
                for (j, part) in parts.into_iter().enumerate() {
                    let Some(part) = part.0 else { continue };
                    match part.kind.as_str().unwrap_or_default() {
                        "text" => {
                            if let Some(text) = part.text.0 {
                                texts.push((j, text));
                            }
                        }
                        "image" => {
                            if let Some(image) = image_ref(
                                part.source.0.as_ref(),
                                format!("{base}/{j}/source/data"),
                                line,
                            ) {
                                images.push(image);
                            }
                        }
                        _ => {}
                    }
                }
                match texts.len() {
                    0 => (Cow::Borrowed(""), None),
                    1 => {
                        let (j, text) = texts.pop().expect("len checked");
                        (text, Some(format!("{base}/{j}/text")))
                    }
                    _ => {
                        let joined = texts
                            .iter()
                            .map(|(_, t)| t.as_ref())
                            .collect::<Vec<_>>()
                            .join("\n");
                        (Cow::Owned(joined), Some(base))
                    }
                }
            }
            RawContent::None => (Cow::Borrowed(""), None),
        };
        let text = if text.contains(SYSTEM_REMINDER_OPEN) {
            Cow::Owned(strip_system_reminders(&text))
        } else {
            text
        };
        let p = preview(&text);
        let is_error = item.is_error.as_ref().and_then(Value::as_bool) == Some(true);
        let interrupted = tool_use_result
            .and_then(|r| r.interrupted.as_ref())
            .and_then(Value::as_bool)
            == Some(true);
        let status = if interrupted {
            ToolStatus::Interrupted
        } else if is_error {
            ToolStatus::Error
        } else {
            ToolStatus::Success
        };
        let slot = self.calls.get(&call_id);
        let is_shell = slot.is_some_and(|s| s.name == "Bash");
        let exit_code = parse_exit_code(&text).or_else(|| {
            let background = tool_use_result.is_some_and(|r| r.background_task_id.is_some());
            (is_shell && status == ToolStatus::Success && !background).then_some(0)
        });
        let duration_ms = match (is_shell, slot.and_then(|s| s.ts), ts) {
            (true, Some(start), Some(end)) if end >= start => Some((end - start) as u64),
            _ => None,
        };
        let saved_path = tool_use_result
            .and_then(|r| r.persisted_output_path.as_ref())
            .and_then(Value::as_str)
            .filter(|p| !p.is_empty())
            .map(str::to_string);
        let full = if p.truncated {
            saved_path
                .as_deref()
                .and_then(|path| self.sidecar_rel_path(path))
                .map(|rel_path| ContentRef::Sidecar { rel_path })
                .or_else(|| pointer.map(|ptr| line.content_ref(ptr)))
        } else {
            None
        };
        self.backfill_call(&call_id, status, tool_use_result);
        SessionBlock::ToolResult {
            call_id,
            status,
            preview: p.text,
            total_len: p.total_len,
            line_count: p.line_count,
            truncated: p.truncated,
            full,
            exit_code,
            duration_ms,
            images,
            saved_path,
        }
    }
    /// 结果到来时回填对应 ToolCall：Edit/Write 用 `structuredPatch` 修正 diff，
    /// 失败的改动去掉 diff；Agent 用实际模型补 detail。
    fn backfill_call(&mut self, call_id: &str, status: ToolStatus, result: Option<&ToolUseResult>) {
        let Some(slot) = self.calls.get(call_id) else {
            return;
        };
        let Some(SessionBlock::ToolCall {
            raw_name,
            detail,
            diff,
            ..
        }) = self
            .drafts
            .get_mut(slot.draft)
            .and_then(|d| d.blocks.get_mut(slot.block))
        else {
            return;
        };
        match raw_name.as_str() {
            "Edit" | "MultiEdit" | "Write" => {
                if status != ToolStatus::Success {
                    *diff = None;
                    return;
                }
                let Some(result) = result else { return };
                let op = match result.kind.as_ref().and_then(Value::as_str) {
                    Some("create") => Some(DiffOp::Add),
                    Some("update") => Some(DiffOp::Update),
                    _ => None,
                };
                let path = result
                    .file_path
                    .as_ref()
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let patch = result.structured_patch.filter(|p| p.added + p.removed > 0);
                if op.is_none() && patch.is_none() {
                    return;
                }
                let summary = diff.get_or_insert_with(|| DiffSummary {
                    files: vec![DiffFile {
                        path: String::new(),
                        op: DiffOp::Update,
                        added: 0,
                        removed: 0,
                    }],
                    added: 0,
                    removed: 0,
                    full: None,
                });
                if let Some(file) = summary.files.first_mut() {
                    if let Some(op) = op {
                        file.op = op;
                    }
                    if let Some(path) = path {
                        file.path = path;
                    }
                    if let Some(patch) = patch {
                        file.added = patch.added;
                        file.removed = patch.removed;
                    }
                    summary.added = file.added;
                    summary.removed = file.removed;
                }
            }
            "Agent" | "Task" if detail.is_none() => {
                *detail = result
                    .and_then(|r| r.resolved_model.as_ref())
                    .and_then(Value::as_str)
                    .filter(|m| !m.is_empty())
                    .map(str::to_string);
            }
            _ => {}
        }
    }
    /// `persistedOutputPath` 在会话附属目录内时，转成相对路径（`ContentRef::Sidecar`）。
    fn sidecar_rel_path(&self, saved: &str) -> Option<String> {
        Path::new(saved)
            .strip_prefix(&self.sidecar_dir)
            .ok()
            .map(|rel| rel.to_string_lossy().replace('\\', "/"))
            .filter(|rel| !rel.is_empty())
    }
}
const SYSTEM_REMINDER_OPEN: &str = "<system-reminder>";
const SYSTEM_REMINDER_CLOSE: &str = "</system-reminder>";
fn thinking_block(
    item: &RawItem<'_>,
    kind: &str,
    index: usize,
    duration_ms: Option<u64>,
    line: JsonlSpan,
) -> Option<SessionBlock> {
    let text = item.thinking.as_str().unwrap_or_default();
    let has_signature = item.signature.as_str().is_some_and(|s| !s.is_empty());
    let redacted = kind == "redacted_thinking" || (text.trim().is_empty() && has_signature);
    if text.trim().is_empty() && !redacted {
        return None;
    }
    let p = preview_chars(text, THINKING_PREVIEW_CHARS);
    Some(SessionBlock::Thinking {
        text: p.text,
        summary: None,
        redacted,
        duration_ms,
        full: p
            .truncated
            .then(|| line.content_ref(format!("/message/content/{index}/thinking"))),
    })
}
fn tool_call_block(item: RawItem<'_>, index: usize, line: JsonlSpan) -> SessionBlock {
    let id = item.id.as_str().unwrap_or_default().to_string();
    let raw_name = item.name.as_str().unwrap_or("unknown").to_string();
    let input = item.input.unwrap_or(Value::Null);
    let input_json = if input.is_null() {
        String::new()
    } else {
        serde_json::to_string(&input).unwrap_or_default()
    };
    let p = preview_chars(&input_json, INPUT_PREVIEW_CHARS);
    let normalized = normalize_tool(ToolSource::Claude, &raw_name, None);
    let (kind, title, detail) = claude_tool_title(&raw_name, &normalized, &input);
    let diff = input_diff(&raw_name, &input);
    SessionBlock::ToolCall {
        id,
        raw_name,
        kind,
        title,
        detail,
        server: normalized.server,
        input_preview: p.text,
        input_total_len: p.total_len,
        input_full: p
            .truncated
            .then(|| line.content_ref(format!("/message/content/{index}/input"))),
        diff,
        by_user: false,
    }
}
/// 按 §3.3 提炼 Claude 工具的 kind（Bash 细化为 search）、标题与次要信息。
fn claude_tool_title(
    raw_name: &str,
    normalized: &NormalizedTool,
    input: &Value,
) -> (ToolKind, String, Option<String>) {
    let s = |key: &str| {
        input
            .get(key)
            .and_then(Value::as_str)
            .filter(|v| !v.trim().is_empty())
    };
    let kind = normalized.kind;
    if kind == ToolKind::Mcp {
        let (server, tool) = split_mcp_name(raw_name)
            .unwrap_or((normalized.server.as_deref().unwrap_or_default(), raw_name));
        return (kind, title_mcp(server, tool), first_string_field(input));
    }
    match raw_name {
        "Bash" => {
            let command = s("command").unwrap_or_default();
            (
                refine_shell_kind(command),
                title_shell(command),
                s("description").map(one_line_title),
            )
        }
        "Read" => {
            let u = |key: &str| input.get(key).and_then(Value::as_u64);
            let (title, detail) =
                title_read(s("file_path").unwrap_or_default(), u("offset"), u("limit"));
            (kind, title, detail)
        }
        "Grep" => (
            kind,
            title_search(
                s("pattern").unwrap_or_default(),
                s("path").or_else(|| s("glob")),
            ),
            s("output_mode").map(str::to_string),
        ),
        "Glob" => (
            kind,
            title_search(s("pattern").unwrap_or_default(), s("path")),
            None,
        ),
        "ToolSearch" => (
            kind,
            title_search(s("query").unwrap_or_default(), None),
            None,
        ),
        "Edit" | "MultiEdit" | "Write" => {
            (kind, title_path(s("file_path").unwrap_or_default()), None)
        }
        "NotebookEdit" => (
            kind,
            title_path(s("notebook_path").unwrap_or_default()),
            None,
        ),
        "WebFetch" => (kind, title_web(&[s("url").unwrap_or_default()]), None),
        "WebSearch" => (kind, title_web(&[s("query").unwrap_or_default()]), None),
        "Agent" | "Task" => (
            kind,
            title_agent(s("description").or_else(|| s("prompt")).unwrap_or_default()),
            s("model").map(str::to_string),
        ),
        "AskUserQuestion" => {
            let question = input
                .get("questions")
                .and_then(Value::as_array)
                .and_then(|qs| qs.first())
                .and_then(|q| q.get("question"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            (kind, title_ask(question), None)
        }
        "TodoWrite" => {
            let count = input
                .get("todos")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            (kind, title_todo(count), None)
        }
        _ if kind == ToolKind::Agent => (
            kind,
            first_string_field(input).unwrap_or_else(|| title_other(raw_name)),
            None,
        ),
        _ => (kind, title_other(raw_name), first_string_field(input)),
    }
}
/// 从工具参数估算的 diff；结果记录到来后用 `structuredPatch` 修正（见 `backfill_call`）。
fn input_diff(raw_name: &str, input: &Value) -> Option<DiffSummary> {
    fn s<'v>(value: &'v Value, key: &str) -> &'v str {
        value.get(key).and_then(Value::as_str).unwrap_or_default()
    }
    let path = s(input, "file_path");
    let (op, added, removed) = match raw_name {
        "Edit" => {
            let (added, removed) =
                line_change_counts(s(input, "old_string"), s(input, "new_string"));
            (DiffOp::Update, added, removed)
        }
        "MultiEdit" => {
            let edits = input.get("edits").and_then(Value::as_array)?;
            edits
                .iter()
                .fold((DiffOp::Update, 0, 0), |(op, a, r), edit| {
                    let (added, removed) =
                        line_change_counts(s(edit, "old_string"), s(edit, "new_string"));
                    (op, a + added, r + removed)
                })
        }
        "Write" => {
            let lines = u32::try_from(s(input, "content").lines().count()).unwrap_or(u32::MAX);
            (DiffOp::Add, lines, 0)
        }
        _ => return None,
    };
    if path.is_empty() {
        return None;
    }
    Some(DiffSummary {
        files: vec![DiffFile {
            path: path.to_string(),
            op,
            added,
            removed,
        }],
        added,
        removed,
        full: None,
    })
}
fn image_ref(source: Option<&RawSource<'_>>, pointer: String, line: JsonlSpan) -> Option<ImageRef> {
    let source = source?;
    if source.kind.as_str() != Some("base64") {
        return None;
    }
    let data = source.data.as_str()?;
    Some(ImageRef {
        source: ImageSource::Inline {
            content: line.content_ref(pointer),
        },
        media_type: source
            .media_type
            .as_str()
            .unwrap_or("application/octet-stream")
            .to_string(),
        size: estimate_base64_size(data.len()),
        alt: None,
    })
}
/// 用户 `!cmd`：`<bash-input>cmd</bash-input><bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>`
fn user_bash_blocks(text: &str, uuid: Option<&str>) -> Vec<SessionBlock> {
    let command = tag_content(text, "bash-input").unwrap_or_default();
    let id = format!("user-bash-{}", uuid.unwrap_or_default());
    let input = preview_chars(command, INPUT_PREVIEW_CHARS);
    let mut blocks = vec![SessionBlock::ToolCall {
        id: id.clone(),
        raw_name: "Bash".to_string(),
        kind: refine_shell_kind(command),
        title: title_shell(command),
        detail: None,
        server: None,
        input_preview: input.text,
        input_total_len: input.total_len,
        input_full: None,
        diff: None,
        by_user: true,
    }];
    let stdout = tag_content(text, "bash-stdout");
    let stderr = tag_content(text, "bash-stderr");
    if stdout.is_some() || stderr.is_some() {
        let stdout = stdout.unwrap_or_default().trim_end();
        let stderr = stderr.unwrap_or_default().trim_end();
        let output = match (stdout.is_empty(), stderr.is_empty()) {
            (_, true) => stdout.to_string(),
            (true, false) => stderr.to_string(),
            (false, false) => format!("{stdout}\n{stderr}"),
        };
        let p = preview(&output);
        blocks.push(SessionBlock::ToolResult {
            call_id: id,
            status: if stderr.is_empty() {
                ToolStatus::Success
            } else {
                ToolStatus::Unknown
            },
            preview: p.text,
            total_len: p.total_len,
            line_count: p.line_count,
            truncated: p.truncated,
            full: None,
            exit_code: None,
            duration_ms: None,
            images: Vec::new(),
            saved_path: None,
        });
    }
    blocks
}
fn message_meta(
    model: &LStr<'_>,
    usage: Option<&Value>,
    stop_reason: &LStr<'_>,
) -> Option<MessageMeta> {
    let tokens = |key: &str| {
        usage
            .and_then(|u| u.get(key))
            .and_then(Value::as_u64)
            .filter(|n| *n > 0)
    };
    let meta = MessageMeta {
        model: model
            .as_str()
            .filter(|m| !m.is_empty() && *m != "<synthetic>")
            .map(str::to_string),
        input_tokens: tokens("input_tokens"),
        output_tokens: tokens("output_tokens"),
        cache_read_tokens: tokens("cache_read_input_tokens"),
        cache_write_tokens: tokens("cache_creation_input_tokens"),
        stop_reason: stop_reason.as_str().map(str::to_string),
        ..MessageMeta::default()
    };
    (meta != MessageMeta::default()).then_some(meta)
}
/// 同一回复拆成的多条记录：后到的非空字段覆盖先前的（usage 以最后一块为准）。
fn merge_meta(target: &mut Option<MessageMeta>, next: Option<MessageMeta>) {
    let Some(next) = next else { return };
    let Some(current) = target.as_mut() else {
        *target = Some(next);
        return;
    };
    macro_rules! take {
        ($($field:ident),*) => {
            $(if next.$field .is_some() { current.$field = next.$field; })*
        };
    }
    take!(
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        stop_reason
    );
}
/// 去掉所有 `<system-reminder>…</system-reminder>` 片段；没有闭合标签时去到末尾。
fn strip_system_reminders(text: &str) -> String {
    if !text.contains(SYSTEM_REMINDER_OPEN) {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(SYSTEM_REMINDER_OPEN) {
        out.push_str(&rest[..start]);
        let after = &rest[start + SYSTEM_REMINDER_OPEN.len()..];
        rest = match after.find(SYSTEM_REMINDER_CLOSE) {
            Some(end) => &after[end + SYSTEM_REMINDER_CLOSE.len()..],
            None => "",
        };
    }
    out.push_str(rest);
    out.trim().to_string()
}
/// 系统/工具注入、不是用户亲手输入的文本。
fn is_injected_text(text: &str) -> bool {
    text.contains("<local-command-caveat>")
        || text.starts_with("<local-command-stdout>")
        || text.starts_with("<local-command-stderr>")
        || text.starts_with("<task-notification>")
}
/// `<command-name>/compact</command-name><command-args>…</command-args>` → `/compact …`
fn slash_command(text: &str) -> Option<String> {
    if !text.starts_with("<command-") {
        return None;
    }
    let name = tag_content(text, "command-name")?.trim();
    if name.is_empty() {
        return None;
    }
    let args = tag_content(text, "command-args").unwrap_or_default().trim();
    Some(if args.is_empty() {
        name.to_string()
    } else {
        format!("{name} {args}")
    })
}
/// 取 `<tag>…</tag>` 之间的内容（第一处）。
fn tag_content<'t>(text: &'t str, tag: &str) -> Option<&'t str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close).map_or(text.len(), |i| start + i);
    Some(&text[start..end])
}
/// `Exit code N` 开头的工具输出（Claude Bash 失败时的格式）
fn parse_exit_code(text: &str) -> Option<i32> {
    let first = text.trim_start().lines().next()?;
    let rest = first.strip_prefix("Error: ").unwrap_or(first);
    rest.strip_prefix("Exit code ")?.trim().parse().ok()
}
fn content_text(content: &RawContent<'_>) -> String {
    match content {
        RawContent::Text(text) => text.to_string(),
        RawContent::Items(items) => items
            .iter()
            .filter_map(|item| item.0.as_ref())
            .filter(|item| item.kind.as_str() == Some("text"))
            .filter_map(|item| item.text.as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        RawContent::None => String::new(),
    }
}
fn is_true(value: &Option<Value>) -> bool {
    value.as_ref().and_then(Value::as_bool) == Some(true)
}
fn as_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_f64().filter(|n| *n >= 0.0).map(|n| n as u64))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRecord<'a> {
    #[serde(rename = "type", default, borrow)]
    kind: LStr<'a>,
    #[serde(default, borrow)]
    subtype: LStr<'a>,
    #[serde(default)]
    is_meta: Option<Value>,
    #[serde(default)]
    is_sidechain: Option<Value>,
    #[serde(default)]
    is_compact_summary: Option<Value>,
    #[serde(default, borrow)]
    uuid: LStr<'a>,
    #[serde(default)]
    timestamp: Option<Value>,
    #[serde(default, borrow)]
    message: Lenient<RawMessage<'a>>,
    #[serde(default)]
    tool_use_result: Lenient<ToolUseResult>,
    #[serde(default)]
    thinking_duration_ms: Option<Value>,
    #[serde(default)]
    hook_errors: Option<Value>,
    /// system 记录的正文（compact_boundary / local_command）
    #[serde(default, borrow)]
    content: LStr<'a>,
    #[serde(default, borrow)]
    pr_url: LStr<'a>,
    #[serde(default)]
    pr_number: Option<Value>,
}
#[derive(Deserialize)]
struct RawMessage<'a> {
    #[serde(default, borrow)]
    role: LStr<'a>,
    #[serde(default, borrow)]
    id: LStr<'a>,
    #[serde(default, borrow)]
    model: LStr<'a>,
    #[serde(default, borrow)]
    stop_reason: LStr<'a>,
    #[serde(default)]
    usage: Option<Value>,
    #[serde(default, borrow)]
    content: RawContent<'a>,
}
/// `message.content[]` 与 `tool_result.content[]` 的元素（字段取并集）
#[derive(Deserialize)]
struct RawItem<'a> {
    #[serde(rename = "type", default, borrow)]
    kind: LStr<'a>,
    #[serde(default, borrow)]
    text: LStr<'a>,
    #[serde(default, borrow)]
    thinking: LStr<'a>,
    #[serde(default, borrow)]
    signature: LStr<'a>,
    #[serde(default, borrow)]
    id: LStr<'a>,
    #[serde(default, borrow)]
    name: LStr<'a>,
    #[serde(default)]
    input: Option<Value>,
    #[serde(default, borrow)]
    tool_use_id: LStr<'a>,
    #[serde(default)]
    is_error: Option<Value>,
    #[serde(default, borrow)]
    content: RawContent<'a>,
    #[serde(default, borrow)]
    source: Lenient<RawSource<'a>>,
}
#[derive(Deserialize)]
struct RawSource<'a> {
    #[serde(rename = "type", default, borrow)]
    kind: LStr<'a>,
    #[serde(default, borrow)]
    media_type: LStr<'a>,
    #[serde(default, borrow)]
    data: LStr<'a>,
}
/// 顶层 `toolUseResult`：只取回填需要的字段（stdout、file、originalFile 等大字段跳过）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolUseResult {
    #[serde(default)]
    interrupted: Option<Value>,
    #[serde(default)]
    persisted_output_path: Option<Value>,
    #[serde(rename = "type", default)]
    kind: Option<Value>,
    #[serde(default)]
    file_path: Option<Value>,
    #[serde(default)]
    resolved_model: Option<Value>,
    #[serde(default)]
    background_task_id: Option<Value>,
    #[serde(default)]
    structured_patch: Option<PatchCounts>,
}
/// 宽松的借用字符串：非字符串值当作 `None`。
#[derive(Default)]
struct LStr<'a>(Option<Cow<'a, str>>);
impl LStr<'_> {
    fn as_str(&self) -> Option<&str> {
        self.0.as_deref()
    }
}
/// 只接受对象的宽松包装：其他类型当作 `None`。
struct Lenient<T>(Option<T>);
impl<T> Default for Lenient<T> {
    fn default() -> Self {
        Self(None)
    }
}
/// 字符串或块数组（`message.content` / `tool_result.content`）
#[derive(Default)]
enum RawContent<'a> {
    #[default]
    None,
    Text(Cow<'a, str>),
    Items(Vec<Lenient<RawItem<'a>>>),
}
/// `structuredPatch` 里以 `+` / `-` 开头的行数
#[derive(Clone, Copy, Default)]
struct PatchCounts {
    added: u32,
    removed: u32,
}
/// 非预期类型的值整段跳过，返回 `$value`。
macro_rules! skip_other_values {
    ($value:expr) => {
        fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
            Ok($value)
        }
        fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
            Ok($value)
        }
        fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
            Ok($value)
        }
        fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> {
            Ok($value)
        }
        fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok($value)
        }
        fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok($value)
        }
    };
}
/// 字符串值整段跳过，返回 `$value`。
macro_rules! skip_str_values {
    ($value:expr) => {
        fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> {
            Ok($value)
        }
    };
}
/// 数组 / 对象整段跳过，返回 `$value`。
macro_rules! skip_seq_values {
    ($value:expr) => {
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            while seq.next_element::<IgnoredAny>()?.is_some() {}
            Ok($value)
        }
    };
}
macro_rules! skip_map_values {
    ($value:expr) => {
        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
            Ok($value)
        }
    };
}
impl<'de: 'a, 'a> Deserialize<'de> for LStr<'a> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct V<'a>(PhantomData<&'a ()>);
        impl<'de: 'a, 'a> Visitor<'de> for V<'a> {
            type Value = LStr<'a>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("any value")
            }
            fn visit_borrowed_str<E: de::Error>(self, v: &'de str) -> Result<Self::Value, E> {
                Ok(LStr(Some(Cow::Borrowed(v))))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(LStr(Some(Cow::Owned(v.to_string()))))
            }
            fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
                Ok(LStr(Some(Cow::Owned(v))))
            }
            skip_other_values!(LStr(None));
            skip_seq_values!(LStr(None));
            skip_map_values!(LStr(None));
        }
        deserializer.deserialize_any(V(PhantomData))
    }
}
impl<'de, T: Deserialize<'de>> Deserialize<'de> for Lenient<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct V<T>(PhantomData<T>);
        impl<'de, T: Deserialize<'de>> Visitor<'de> for V<T> {
            type Value = Lenient<T>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("any value")
            }
            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Self::Value, A::Error> {
                T::deserialize(de::value::MapAccessDeserializer::new(map)).map(|v| Lenient(Some(v)))
            }
            skip_other_values!(Lenient(None));
            skip_str_values!(Lenient(None));
            skip_seq_values!(Lenient(None));
        }
        deserializer.deserialize_any(V(PhantomData))
    }
}
impl<'de: 'a, 'a> Deserialize<'de> for RawContent<'a> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct V<'a>(PhantomData<&'a ()>);
        impl<'de: 'a, 'a> Visitor<'de> for V<'a> {
            type Value = RawContent<'a>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("string or array")
            }
            fn visit_borrowed_str<E: de::Error>(self, v: &'de str) -> Result<Self::Value, E> {
                Ok(RawContent::Text(Cow::Borrowed(v)))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(RawContent::Text(Cow::Owned(v.to_string())))
            }
            fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
                Ok(RawContent::Text(Cow::Owned(v)))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut items = Vec::with_capacity(seq.size_hint().unwrap_or(0));
                while let Some(item) = seq.next_element::<Lenient<RawItem<'a>>>()? {
                    items.push(item);
                }
                Ok(RawContent::Items(items))
            }
            skip_other_values!(RawContent::None);
            skip_map_values!(RawContent::None);
        }
        deserializer.deserialize_any(V(PhantomData))
    }
}
impl<'de> Deserialize<'de> for PatchCounts {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        /// hunk 对象：只看 `lines`
        struct Hunk;
        impl<'de> Visitor<'de> for Hunk {
            type Value = PatchCounts;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("hunk")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut counts = PatchCounts::default();
                while let Some(key) = map.next_key::<LStr<'_>>()? {
                    if key.as_str() == Some("lines") {
                        counts = map.next_value_seed(Lines)?;
                    } else {
                        map.next_value::<IgnoredAny>()?;
                    }
                }
                Ok(counts)
            }
            skip_other_values!(PatchCounts::default());
            skip_str_values!(PatchCounts::default());
            skip_seq_values!(PatchCounts::default());
        }
        /// `lines` 数组：按首字符计数
        struct Lines;
        impl<'de> de::DeserializeSeed<'de> for Lines {
            type Value = PatchCounts;
            fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
                d.deserialize_any(self)
            }
        }
        impl<'de> Visitor<'de> for Lines {
            type Value = PatchCounts;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("lines")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut counts = PatchCounts::default();
                while let Some(line) = seq.next_element::<LStr<'_>>()? {
                    match line.as_str().and_then(|l| l.chars().next()) {
                        Some('+') => counts.added += 1,
                        Some('-') => counts.removed += 1,
                        _ => {}
                    }
                }
                Ok(counts)
            }
            skip_other_values!(PatchCounts::default());
            skip_str_values!(PatchCounts::default());
            skip_map_values!(PatchCounts::default());
        }
        /// 外层 hunk 数组：累加
        struct Hunks;
        impl<'de> Visitor<'de> for Hunks {
            type Value = PatchCounts;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("structuredPatch")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut total = PatchCounts::default();
                while let Some(hunk) = seq.next_element_seed(HunkSeed)? {
                    total.added += hunk.added;
                    total.removed += hunk.removed;
                }
                Ok(total)
            }
            skip_other_values!(PatchCounts::default());
            skip_str_values!(PatchCounts::default());
            skip_map_values!(PatchCounts::default());
        }
        struct HunkSeed;
        impl<'de> de::DeserializeSeed<'de> for HunkSeed {
            type Value = PatchCounts;
            fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
                d.deserialize_any(Hunk)
            }
        }
        deserializer.deserialize_any(Hunks)
    }
}
