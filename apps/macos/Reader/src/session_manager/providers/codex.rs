// Derived from CC Switch 4.0.21 (6d6b716); MIT, Copyright (c) 2025 Jason Young.
// Session reading only. See UPSTREAM.json and LICENSE.
#![allow(dead_code, unused_imports)]
use super::blocks::{
    first_string_field, large_text_block, normalize_tool, preview, preview_chars,
    refine_shell_kind, summary_event_block, title_agent, title_ask, title_mcp, title_other,
    title_path, title_read, title_shell, title_todo, title_web, ToolSource, THINKING_PREVIEW_CHARS,
};
use super::codex_items::{
    apply_patch_rejected, command_from_value, diff_kind, diff_summary, diff_title, exec_title,
    image_from_url, local_image, opt_str, parse_apply_patch, parse_exec_script,
    parse_legacy_shell_output, same_command, status_from_str, strip_output_header,
    web_action_title, CallSpec, CommandInfo, Contents, FileChangeInfo, ItemRecord, RawItem,
    ResultSpec, Str,
};
use super::utils::{
    extract_text, parse_timestamp_to_ms, path_basename, read_head_tail_lines, truncate_summary,
    JsonlSpan, LineSpans, TITLE_MAX_CHARS,
};
use crate::codex_rollout_file;
use crate::session_manager::model::{
    project_content, ContentRef, EventKind, ImageRef, MessageMeta, SessionBlock, ToolKind,
    ToolStatus,
};
use crate::session_manager::SessionMessage;
use regex::Regex;
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::Value;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;
const VSCODE_CONTEXT_PREFIX: &str = "# Context from my IDE setup:";
const CODEX_REQUEST_MARKER: &str = "my request for codex";
#[derive(Deserialize)]
struct SessionIndexEntry {
    id: String,
    thread_name: String,
}
/// 嗅探行首类型时最多看的字节数
const SNIFF_BYTES: usize = 512;
/// 注入型用户文本的前缀（AGENTS.md、环境上下文等，不是用户的提问）
const INJECTED_USER_PREFIXES: [&str; 4] = [
    "# AGENTS.md instructions",
    "<environment_context>",
    "<user_instructions>",
    "<turn_aborted>",
];
pub fn load_messages(path: &Path) -> Result<Vec<SessionMessage>, String> {
    let reader = codex_rollout_file::open_reader(path)
        .map_err(|e| format!("Failed to open session file: {e}"))?;
    let mut lines = LineSpans::new(reader);
    let mut parser = RolloutParser::default();
    while let Some(line) = lines
        .next_line()
        .map_err(|e| format!("Failed to read session file: {e}"))?
    {
        let mut bytes = line.bytes;
        while let [rest @ .., b'\n' | b'\r'] = bytes {
            bytes = rest;
        }
        if !bytes.is_empty() {
            parser.process_line(bytes, line.span);
        }
    }
    Ok(parser.finish())
}
#[derive(Deserialize)]
struct Line<'a, P> {
    #[serde(default, borrow)]
    timestamp: Option<Str<'a>>,
    payload: P,
}
#[derive(Deserialize)]
struct Head<'a> {
    #[serde(rename = "type", default, borrow)]
    ty: Option<Str<'a>>,
    #[serde(default, borrow)]
    payload: Option<PayloadHead<'a>>,
}
#[derive(Deserialize)]
struct PayloadHead<'a> {
    #[serde(rename = "type", default, borrow)]
    ty: Option<Str<'a>>,
}
#[derive(Deserialize)]
struct MessagePayload<'a> {
    #[serde(default, borrow)]
    id: Option<Str<'a>>,
    #[serde(default, borrow)]
    role: Option<Str<'a>>,
    #[serde(default, borrow)]
    content: Option<Contents<'a>>,
    #[serde(default, borrow)]
    phase: Option<Str<'a>>,
}
#[derive(Deserialize)]
struct ReasoningPayload<'a> {
    #[serde(default, borrow)]
    id: Option<Str<'a>>,
    #[serde(default, borrow)]
    summary: Option<Contents<'a>>,
    #[serde(default, borrow)]
    content: Option<Contents<'a>>,
}
#[derive(Deserialize)]
struct FunctionCallPayload<'a> {
    #[serde(default, borrow)]
    id: Option<Str<'a>>,
    #[serde(default, borrow)]
    name: Option<Str<'a>>,
    #[serde(default, borrow)]
    namespace: Option<Str<'a>>,
    #[serde(default, borrow)]
    arguments: Option<Str<'a>>,
    #[serde(default, borrow)]
    call_id: Option<Str<'a>>,
}
#[derive(Deserialize)]
struct CustomCallPayload<'a> {
    #[serde(default, borrow)]
    id: Option<Str<'a>>,
    #[serde(default, borrow)]
    name: Option<Str<'a>>,
    #[serde(default, borrow)]
    input: Option<Str<'a>>,
    #[serde(default, borrow)]
    call_id: Option<Str<'a>>,
}
#[derive(Deserialize)]
struct OutputPayload<'a> {
    #[serde(default, borrow)]
    id: Option<Str<'a>>,
    #[serde(default, borrow)]
    call_id: Option<Str<'a>>,
    #[serde(default, borrow)]
    output: Option<Contents<'a>>,
}
#[derive(Deserialize)]
struct ActionPayload<'a> {
    #[serde(default, borrow)]
    id: Option<Str<'a>>,
    #[serde(default, borrow)]
    call_id: Option<Str<'a>>,
    #[serde(default, borrow)]
    status: Option<Str<'a>>,
    #[serde(default)]
    action: Option<Value>,
}
#[derive(Deserialize)]
struct AgentMessagePayload<'a> {
    #[serde(default, borrow)]
    id: Option<Str<'a>>,
    #[serde(default, borrow)]
    author: Option<Str<'a>>,
    #[serde(default, borrow)]
    content: Option<Contents<'a>>,
}
#[derive(Deserialize)]
struct TurnContextPayload<'a> {
    #[serde(default, borrow)]
    turn_id: Option<Str<'a>>,
    #[serde(default, borrow)]
    model: Option<Str<'a>>,
}
#[derive(Deserialize, Default, Clone, Copy)]
struct TokenUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    cached_input_tokens: u64,
    #[serde(default)]
    cache_write_input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    reasoning_output_tokens: u64,
}
impl TokenUsage {
    fn add(&mut self, other: &TokenUsage) {
        self.input_tokens += other.input_tokens;
        self.cached_input_tokens += other.cached_input_tokens;
        self.cache_write_input_tokens += other.cache_write_input_tokens;
        self.output_tokens += other.output_tokens;
        self.reasoning_output_tokens += other.reasoning_output_tokens;
    }
}
#[derive(Deserialize)]
struct UsageRecordPayload<'a> {
    #[serde(default, borrow)]
    turn_id: Option<Str<'a>>,
    #[serde(default)]
    turn_token_usage: Option<TokenUsage>,
}
#[derive(Deserialize)]
struct CompactedPayload<'a> {
    #[serde(default, borrow)]
    message: Option<Str<'a>>,
}
#[derive(Deserialize)]
struct ThreadSettings<'a> {
    #[serde(default, borrow)]
    model: Option<Str<'a>>,
}
#[derive(Deserialize)]
struct TokenInfo {
    #[serde(default)]
    last_token_usage: Option<TokenUsage>,
}
/// item_completed 以外的 event_msg（task_started / task_complete / turn_aborted /
/// thread_settings_applied / token_count）
#[derive(Deserialize)]
struct EventPayload<'a> {
    #[serde(default, borrow)]
    turn_id: Option<Str<'a>>,
    #[serde(default)]
    reason: Option<Value>,
    #[serde(default, borrow)]
    thread_settings: Option<ThreadSettings<'a>>,
    #[serde(default)]
    info: Option<TokenInfo>,
}
#[derive(Deserialize)]
struct ItemCompletedPayload<'a> {
    #[serde(borrow)]
    item: RawItem<'a>,
}
fn owned(value: &Option<Str<'_>>) -> Option<String> {
    opt_str(value).map(str::to_string)
}
fn parse_ts(raw: Option<&Str<'_>>) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(raw?.as_str())
        .ok()
        .map(|dt| dt.timestamp_millis())
}
/// 解析整行，只取 `timestamp` 与指定形状的 `payload`
fn parse_line<'a, P: Deserialize<'a>>(line: &'a [u8]) -> Option<(Option<i64>, P)> {
    let parsed: Line<'a, P> = serde_json::from_slice(line).ok()?;
    Some((parse_ts(parsed.timestamp.as_ref()), parsed.payload))
}
/// 从行首嗅探 `(顶层 type, payload.type)`，避免为分派把大行完整解析两遍。
/// Codex 写出的行形如 `{"timestamp":…,"ordinal":N,"type":"response_item","payload":{"type":"…",…`；
/// 键序不符时返回 `None`，由调用方退回完整解析。
fn sniff_types(line: &[u8]) -> Option<(&str, Option<&str>)> {
    let head = &line[..line.len().min(SNIFF_BYTES)];
    let head = match std::str::from_utf8(head) {
        Ok(head) => head,
        Err(e) => std::str::from_utf8(&head[..e.valid_up_to()]).ok()?,
    };
    let payload_at = head.find("\"payload\":")?;
    let top = quoted_value_after(&head[..payload_at], "\"type\":\"")?;
    let sub = head[payload_at + "\"payload\":".len()..]
        .trim_start()
        .strip_prefix('{')
        .map(str::trim_start)
        .and_then(|p| p.strip_prefix("\"type\":\""))
        .and_then(|p| p.split_once('"'))
        .map(|(ty, _)| ty);
    Some((top, sub))
}
fn quoted_value_after<'s>(haystack: &'s str, key: &str) -> Option<&'s str> {
    let start = haystack.find(key)? + key.len();
    haystack[start..].split_once('"').map(|(value, _)| value)
}
/// 工具调用的来源形态，决定哪些结构化项能挂上来
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CallFlavor {
    /// custom_tool_call(exec)：一段 JS，可能调用多条命令 / MCP / apply_patch
    Exec,
    /// function_call(exec_command/shell)、local_shell_call
    Shell,
    ApplyPatch,
    Mcp,
    Other,
}
struct PendingCall {
    msg_idx: usize,
    block_idx: usize,
    flavor: CallFlavor,
    /// 调用参数里能看到的命令，用来认领 CommandExecution
    cmds: Vec<String>,
    items: Vec<ItemRecord>,
}
/// 工具输出（去掉输出头后的正文 + 头里的结构化信息）
struct OutputInfo {
    text: String,
    full: Option<ContentRef>,
    exit_code: Option<i32>,
    duration_ms: Option<u64>,
    failed: bool,
    images: Vec<ImageRef>,
}
impl OutputInfo {
    fn from_contents(contents: Option<&Contents<'_>>, span: JsonlSpan) -> Self {
        let mut info = OutputInfo {
            text: String::new(),
            full: None,
            exit_code: None,
            duration_ms: None,
            failed: false,
            images: Vec::new(),
        };
        match contents {
            None => {}
            Some(Contents::Text(text)) => {
                let text = text.as_str();
                if let Some((body, exit_code, duration_ms)) = parse_legacy_shell_output(text) {
                    info.text = body;
                    info.exit_code = exit_code;
                    info.duration_ms = duration_ms;
                } else {
                    let header = strip_output_header(text);
                    info.text = header.body.to_string();
                    info.exit_code = header.exit_code;
                    info.duration_ms = header.duration_ms;
                    info.failed = header.failed;
                }
                info.full = Some(span.content_ref("/payload/output"));
            }
            Some(Contents::Items(items)) => {
                let mut pieces: Vec<(usize, &str)> = Vec::new();
                for (i, item) in items.iter().enumerate() {
                    match item.kind() {
                        "input_image" | "image" => {
                            if let Some(url) = opt_str(&item.image_url) {
                                let pointer = format!("/payload/output/{i}/image_url");
                                info.images.extend(image_from_url(url, span, pointer));
                            }
                        }
                        _ => {
                            let Some(text) = opt_str(&item.text) else {
                                continue;
                            };
                            let header = strip_output_header(text);
                            info.exit_code = info.exit_code.or(header.exit_code);
                            info.duration_ms = info.duration_ms.or(header.duration_ms);
                            info.failed |= header.failed;
                            if !header.body.is_empty() {
                                pieces.push((i, header.body));
                            }
                        }
                    }
                }
                info.full = Some(span.content_ref(match pieces.as_slice() {
                    [(i, _)] => format!("/payload/output/{i}/text"),
                    _ => "/payload/output".to_string(),
                }));
                info.text = pieces.iter().map(|(_, t)| *t).collect();
            }
        }
        info
    }
}
#[derive(Default)]
struct RolloutParser {
    messages: Vec<SessionMessage>,
    turn_id: Option<String>,
    /// 最近一次看到的模型（turn_context / thread_settings_applied）
    last_model: Option<String>,
    /// 模型变了，等下一轮开始时输出 ModelChange 事件
    pending_model_event: Option<(String, Option<i64>)>,
    turn_models: HashMap<String, String>,
    turn_usage: HashMap<String, TokenUsage>,
    usage_from_records: bool,
    /// AgentMessage.phase（commentary / final_answer），按消息 id
    phases: HashMap<String, String>,
    calls: HashMap<String, PendingCall>,
    /// 已经输出结果的调用 id。Codex 0.119–0.128 的写入顺序是「调用 → 输出 →
    /// item_completed」，迟到的 item_completed 按 id 命中这里时只回填退出码 / 耗时，
    /// 不再单独成一个步骤（否则同一条命令会显示两次）
    finished: HashSet<String>,
    /// 还没等到输出的调用（按出现顺序）
    open: Vec<String>,
    /// 并行 exec 时归属不明的 CommandExecution，等输出到达时按内容认领
    pool: Vec<CommandInfo>,
    /// 紧跟的 web_search_call 没有 id 时借用 WebSearch 项的 id
    last_web_search_id: Option<String>,
    /// 刚输出的 compaction 事件（compacted / compaction / ContextCompaction 去重）
    last_compaction: Option<usize>,
}
impl RolloutParser {
    fn process_line(&mut self, line: &[u8], span: JsonlSpan) {
        let (top, sub): (Cow<str>, Option<Cow<str>>) = match sniff_types(line) {
            Some((top, Some(sub))) => (Cow::Borrowed(top), Some(Cow::Borrowed(sub))),
            Some((top, None)) if !matches!(top, "response_item" | "event_msg") => {
                (Cow::Borrowed(top), None)
            }
            _ => {
                let Ok(head) = serde_json::from_slice::<Head>(line) else {
                    return;
                };
                let Some(top) = head.ty else {
                    return;
                };
                (top.0, head.payload.and_then(|p| p.ty).map(|t| t.0))
            }
        };
        let sub = sub.as_deref().unwrap_or_default();
        match top.as_ref() {
            "response_item" => self.response_item(sub, line, span),
            "event_msg" => self.event_msg(sub, line, span),
            "turn_context" => {
                if let Some((_, p)) = parse_line::<TurnContextPayload>(line) {
                    if let Some(turn) = owned(&p.turn_id) {
                        self.start_turn(turn);
                    }
                    if let Some(model) = owned(&p.model) {
                        if let Some(turn) = &self.turn_id {
                            self.turn_models.insert(turn.clone(), model.clone());
                        }
                        self.last_model = Some(model);
                    }
                }
            }
            "token_usage_record" => {
                if let Some((_, p)) = parse_line::<UsageRecordPayload>(line) {
                    self.usage_from_records = true;
                    let turn = owned(&p.turn_id).or_else(|| self.turn_id.clone());
                    if let (Some(turn), Some(usage)) = (turn, p.turn_token_usage) {
                        self.turn_usage.insert(turn, usage);
                    }
                }
            }
            "compacted" => {
                if let Some((ts, p)) = parse_line::<CompactedPayload>(line) {
                    let summary = opt_str(&p.message)
                        .filter(|m| !m.trim().is_empty())
                        .map(|m| {
                            summary_event_block(EventKind::Compaction, m, || {
                                Some(span.content_ref("/payload/message"))
                            })
                        });
                    self.compaction_event(ts, summary);
                }
            }
            _ => {}
        }
    }
    fn response_item(&mut self, sub: &str, line: &[u8], span: JsonlSpan) {
        match sub {
            "message" => {
                if let Some((ts, p)) = parse_line::<MessagePayload>(line) {
                    self.on_message(p, ts, span);
                }
            }
            "reasoning" => {
                if let Some((ts, p)) = parse_line::<ReasoningPayload>(line) {
                    self.on_reasoning(p, ts, span);
                }
            }
            "function_call" => {
                if let Some((ts, p)) = parse_line::<FunctionCallPayload>(line) {
                    self.on_function_call(p, ts, span);
                }
            }
            "custom_tool_call" => {
                if let Some((ts, p)) = parse_line::<CustomCallPayload>(line) {
                    self.on_custom_call(p, ts, span);
                }
            }
            "function_call_output" | "custom_tool_call_output" => {
                if let Some((ts, p)) = parse_line::<OutputPayload>(line) {
                    self.on_output(p, ts, span);
                }
            }
            "local_shell_call" => {
                if let Some((ts, p)) = parse_line::<ActionPayload>(line) {
                    self.on_local_shell(p, ts, span);
                }
            }
            "web_search_call" => {
                if let Some((ts, p)) = parse_line::<ActionPayload>(line) {
                    self.on_web_search(p, ts);
                }
            }
            "compaction" => {
                if let Some((ts, _)) = parse_line::<serde::de::IgnoredAny>(line) {
                    self.compaction_event(ts, None);
                }
            }
            "agent_message" => {
                if let Some((ts, p)) = parse_line::<AgentMessagePayload>(line) {
                    self.on_agent_message(p, ts);
                }
            }
            _ => {}
        }
    }
    fn event_msg(&mut self, sub: &str, line: &[u8], span: JsonlSpan) {
        if sub == "item_completed" {
            if let Some((ts, p)) = parse_line::<ItemCompletedPayload>(line) {
                self.on_item(p.item, ts, span);
            }
            return;
        }
        if !matches!(
            sub,
            "task_started"
                | "task_complete"
                | "turn_aborted"
                | "thread_settings_applied"
                | "token_count"
        ) {
            return;
        }
        let Some((ts, p)) = parse_line::<EventPayload>(line) else {
            return;
        };
        match sub {
            "task_started" => {
                if let Some(turn) = owned(&p.turn_id) {
                    self.start_turn(turn);
                }
            }
            "task_complete" => self.flush_pool(ts),
            "turn_aborted" => {
                let reason = match p.reason {
                    Some(Value::String(reason)) => reason,
                    Some(other) if !other.is_null() => other.to_string(),
                    _ => "interrupted".to_string(),
                };
                self.abort_turn(ts, reason);
            }
            "thread_settings_applied" => {
                if let Some(model) = p.thread_settings.as_ref().and_then(|s| owned(&s.model)) {
                    self.note_model(model, ts);
                }
            }
            "token_count" => {
                if self.usage_from_records {
                    return;
                }
                let usage = p.info.and_then(|i| i.last_token_usage);
                if let (Some(turn), Some(usage)) = (self.turn_id.clone(), usage) {
                    self.turn_usage.entry(turn).or_default().add(&usage);
                }
            }
            _ => {}
        }
    }
    fn start_turn(&mut self, turn: String) {
        if self.turn_id.as_deref() != Some(turn.as_str()) {
            self.flush_pool(None);
            if let Some(model) = &self.last_model {
                self.turn_models
                    .entry(turn.clone())
                    .or_insert_with(|| model.clone());
            }
            self.turn_id = Some(turn);
        }
        self.flush_model_event();
    }
    /// 模型与上一个不同才记一次 ModelChange（第一次只作为基准）
    fn note_model(&mut self, model: String, ts: Option<i64>) {
        if self.last_model.as_ref().is_some_and(|last| *last != model) {
            self.pending_model_event = Some((model.clone(), ts));
        }
        self.last_model = Some(model);
    }
    fn flush_model_event(&mut self) {
        if let Some((model, ts)) = self.pending_model_event.take() {
            self.push(
                "system",
                ts,
                None,
                vec![SessionBlock::event(
                    EventKind::ModelChange,
                    Some(model),
                    None,
                )],
                false,
            );
        }
    }
    fn abort_turn(&mut self, ts: Option<i64>, reason: String) {
        for call_id in std::mem::take(&mut self.open) {
            if let Some(call) = self.calls.remove(&call_id) {
                self.finish_call(call_id, call, None, ts, None, true);
            }
        }
        self.flush_pool(ts);
        self.push(
            "system",
            ts,
            None,
            vec![SessionBlock::event(EventKind::Aborted, Some(reason), None)],
            false,
        );
    }
    /// `summary` 为带摘要的 Compaction 事件块（`compacted` 记录）；其余来源只标记发生过压缩。
    fn compaction_event(&mut self, ts: Option<i64>, summary: Option<SessionBlock>) {
        if let Some(idx) = self.last_compaction {
            if let (Some(first), Some(summary)) = (self.messages[idx].blocks.first_mut(), summary) {
                if matches!(first, SessionBlock::Event { text: None, .. }) {
                    *first = summary;
                }
            }
            return;
        }
        let block =
            summary.unwrap_or_else(|| SessionBlock::event(EventKind::Compaction, None, None));
        let idx = self.push("system", ts, None, vec![block], false);
        self.last_compaction = Some(idx);
    }
    fn push(
        &mut self,
        role: &str,
        ts: Option<i64>,
        id: Option<String>,
        blocks: Vec<SessionBlock>,
        injected: bool,
    ) -> usize {
        self.flush_model_event();
        self.last_compaction = None;
        self.messages.push(SessionMessage {
            role: role.to_string(),
            ts,
            id,
            turn_id: self.turn_id.clone(),
            injected,
            blocks,
            ..SessionMessage::default()
        });
        self.messages.len() - 1
    }
    /// 助手侧块：前一条是同一轮「只有思考」的助手消息时并入，否则新起一条。
    /// 返回 `(消息下标, 首个新块下标)`。
    fn push_assistant(
        &mut self,
        ts: Option<i64>,
        id: Option<String>,
        blocks: Vec<SessionBlock>,
    ) -> (usize, usize) {
        self.flush_model_event();
        let turn_id = self.turn_id.clone();
        if let Some(last) = self.messages.last_mut() {
            let thinking_only = !last.blocks.is_empty()
                && last
                    .blocks
                    .iter()
                    .all(|b| matches!(b, SessionBlock::Thinking { .. }));
            if last.role == "assistant" && last.turn_id == turn_id && thinking_only {
                let start = last.blocks.len();
                last.blocks.extend(blocks);
                last.ts = ts.or(last.ts);
                if id.is_some() {
                    last.id = id;
                }
                self.last_compaction = None;
                return (self.messages.len() - 1, start);
            }
        }
        (self.push("assistant", ts, id, blocks, false), 0)
    }
    fn on_message(&mut self, p: MessagePayload<'_>, ts: Option<i64>, span: JsonlSpan) {
        let id = owned(&p.id);
        let Some(contents) = p.content.as_ref() else {
            return;
        };
        match opt_str(&p.role).unwrap_or_default() {
            "user" => self.on_user_message(contents, id, ts, span),
            "assistant" => {
                let text = contents.joined_text("\n");
                if text.trim().is_empty() {
                    return;
                }
                let (idx, _) = self.push_assistant(ts, id, vec![SessionBlock::text(text)]);
                if let Some(phase) = owned(&p.phase) {
                    self.messages[idx]
                        .meta
                        .get_or_insert_with(MessageMeta::default)
                        .stop_reason = Some(phase);
                }
            }
            _ => {
                let text = contents.joined_text("\n");
                if !text.trim().is_empty() {
                    let block = large_text_block(text, || {
                        Some(span.content_ref(contents.text_pointer("/payload/content")))
                    });
                    self.push("system", ts, id, vec![block], true);
                }
            }
        }
    }
    fn on_user_message(
        &mut self,
        contents: &Contents<'_>,
        id: Option<String>,
        ts: Option<i64>,
        span: JsonlSpan,
    ) {
        let mut blocks = Vec::new();
        let mut injected: Vec<(String, String)> = Vec::new();
        let mut pending_text: Vec<String> = Vec::new();
        let flush_text = |pending: &mut Vec<String>, blocks: &mut Vec<SessionBlock>| {
            if !pending.is_empty() {
                blocks.push(SessionBlock::text(pending.join("\n")));
                pending.clear();
            }
        };
        let mut handle_text = |text: &str, pointer: String, pending: &mut Vec<String>| {
            let trimmed = text.trim();
            if trimmed.is_empty() || is_image_wrapper(trimmed) {
                return;
            }
            if INJECTED_USER_PREFIXES
                .iter()
                .any(|p| trimmed.starts_with(p))
                || is_wrapped_in_tag(trimmed)
            {
                injected.push((text.to_string(), pointer));
            } else if trimmed.starts_with(VSCODE_CONTEXT_PREFIX) {
                match extract_codex_prompt_from_ide_context(trimmed) {
                    Some(prompt) => pending.push(prompt),
                    None => injected.push((text.to_string(), pointer)),
                }
            } else {
                pending.push(text.to_string());
            }
        };
        match contents {
            Contents::Text(text) => handle_text(
                text.as_str(),
                "/payload/content".to_string(),
                &mut pending_text,
            ),
            Contents::Items(items) => {
                for (i, item) in items.iter().enumerate() {
                    if matches!(item.kind(), "input_image" | "image") {
                        let pointer = format!("/payload/content/{i}/image_url");
                        if let Some(image) = opt_str(&item.image_url)
                            .and_then(|url| image_from_url(url, span, pointer))
                        {
                            flush_text(&mut pending_text, &mut blocks);
                            blocks.push(SessionBlock::Image { image });
                        }
                    } else if let Some(text) = opt_str(&item.text) {
                        handle_text(
                            text,
                            format!("/payload/content/{i}/text"),
                            &mut pending_text,
                        );
                    }
                }
            }
        }
        flush_text(&mut pending_text, &mut blocks);
        if !injected.is_empty() {
            let injected_blocks = injected
                .into_iter()
                .map(|(text, pointer)| large_text_block(text, || Some(span.content_ref(pointer))))
                .collect();
            self.push("user", ts, id.clone(), injected_blocks, true);
        }
        if !blocks.is_empty() {
            self.push("user", ts, id, blocks, false);
        }
    }
    fn on_reasoning(&mut self, p: ReasoningPayload<'_>, ts: Option<i64>, span: JsonlSpan) {
        let summary = p
            .summary
            .as_ref()
            .map(|s| s.joined_text("\n\n"))
            .unwrap_or_default();
        let content = p
            .content
            .as_ref()
            .map(|c| c.joined_text("\n\n"))
            .unwrap_or_default();
        let redacted = summary.trim().is_empty() && content.trim().is_empty();
        if redacted && self.last_block_is_redacted_thinking() {
            return;
        }
        let text = preview_chars(&content, THINKING_PREVIEW_CHARS);
        let full = match p.content.as_ref() {
            Some(c) if text.truncated => Some(span.content_ref(c.text_pointer("/payload/content"))),
            _ => None,
        };
        let block = SessionBlock::Thinking {
            text: text.text,
            summary: (!summary.trim().is_empty()).then_some(summary),
            redacted,
            duration_ms: None,
            full,
        };
        self.push_assistant(ts, owned(&p.id), vec![block]);
    }
    fn last_block_is_redacted_thinking(&self) -> bool {
        self.messages.last().is_some_and(|m| {
            m.role == "assistant"
                && m.turn_id == self.turn_id
                && matches!(
                    m.blocks.last(),
                    Some(SessionBlock::Thinking { redacted: true, .. })
                )
        })
    }
    fn on_agent_message(&mut self, p: AgentMessagePayload<'_>, ts: Option<i64>) {
        let text = p
            .content
            .as_ref()
            .map(|c| c.joined_text("\n"))
            .unwrap_or_default();
        let text = text.trim();
        let (first, rest) = text.split_once('\n').unwrap_or((text, ""));
        let author = opt_str(&p.author).unwrap_or_default();
        let event = if author.is_empty() {
            first.trim().to_string()
        } else {
            format!("{author}: {}", first.trim())
        };
        let mut blocks = vec![SessionBlock::event(EventKind::SubAgent, Some(event), None)];
        if !rest.trim().is_empty() {
            blocks.push(SessionBlock::text(rest.trim().to_string()));
        }
        self.push("system", ts, owned(&p.id), blocks, false);
    }
    fn on_web_search(&mut self, p: ActionPayload<'_>, ts: Option<i64>) {
        let id = owned(&p.id)
            .or_else(|| self.last_web_search_id.take())
            .unwrap_or_else(|| format!("ws_{}", self.messages.len()));
        self.last_web_search_id = None;
        let action = p.action.unwrap_or(Value::Null);
        let input = if action.is_null() {
            String::new()
        } else {
            action.to_string()
        };
        let status = match opt_str(&p.status).map(status_from_str) {
            Some(ToolStatus::Error) => ToolStatus::Error,
            Some(ToolStatus::Interrupted) => ToolStatus::Interrupted,
            _ => ToolStatus::Success,
        };
        let call = CallSpec::new(
            id.clone(),
            "web_search",
            ToolKind::Web,
            web_action_title(&action),
            &input,
        );
        let result = ResultSpec::empty(id.clone(), status);
        self.push_assistant(ts, Some(id), vec![call.into_block(), result.into_block()]);
    }
    fn register_call(
        &mut self,
        ts: Option<i64>,
        id: Option<String>,
        call_id: String,
        block: SessionBlock,
        flavor: CallFlavor,
        cmds: Vec<String>,
    ) {
        let (msg_idx, block_idx) = self.push_assistant(ts, id, vec![block]);
        self.open.retain(|c| *c != call_id);
        self.open.push(call_id.clone());
        self.calls.insert(
            call_id,
            PendingCall {
                msg_idx,
                block_idx,
                flavor,
                cmds,
                items: Vec::new(),
            },
        );
    }
    fn on_function_call(&mut self, p: FunctionCallPayload<'_>, ts: Option<i64>, span: JsonlSpan) {
        let name = opt_str(&p.name).unwrap_or("unknown");
        let namespace = opt_str(&p.namespace);
        let arguments = opt_str(&p.arguments).unwrap_or_default();
        let args: Value = serde_json::from_str(arguments).unwrap_or(Value::Null);
        let call_id = owned(&p.call_id)
            .or_else(|| owned(&p.id))
            .unwrap_or_default();
        let normalized = normalize_tool(ToolSource::Codex, name, namespace);
        let str_arg = |key: &str| {
            args.get(key)
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
        };
        let mut detail = None;
        let mut cmds = Vec::new();
        let mut flavor = CallFlavor::Other;
        let mut kind = normalized.kind;
        let title = match kind {
            ToolKind::Mcp => {
                flavor = CallFlavor::Mcp;
                detail = first_string_field(&args);
                title_mcp(normalized.server.as_deref().unwrap_or("mcp"), name)
            }
            ToolKind::Shell if name == "write_stdin" => match str_arg("chars") {
                Some(chars) => title_shell(chars),
                None => match args.get("session_id") {
                    Some(id) if !id.is_null() => format!("session {id}"),
                    _ => title_other(name),
                },
            },
            ToolKind::Shell => {
                flavor = CallFlavor::Shell;
                let cmd = args
                    .get("cmd")
                    .or_else(|| args.get("command"))
                    .map(command_from_value)
                    .unwrap_or_default();
                detail = str_arg("workdir").map(str::to_string);
                kind = refine_shell_kind(&cmd);
                let title = title_shell(&cmd);
                if !cmd.is_empty() {
                    cmds.push(cmd);
                }
                title
            }
            ToolKind::Ask => {
                let question = args
                    .get("questions")
                    .and_then(Value::as_array)
                    .and_then(|q| q.first())
                    .and_then(|q| {
                        ["title", "question", "header"]
                            .iter()
                            .find_map(|k| q.get(*k).and_then(Value::as_str))
                    })
                    .or_else(|| str_arg("question"));
                question.map(title_ask).unwrap_or_else(|| title_other(name))
            }
            ToolKind::Agent => {
                detail = str_arg("model").map(str::to_string);
                ["task_name", "description", "agent_type", "target", "name"]
                    .iter()
                    .find_map(|k| str_arg(k))
                    .map(title_agent)
                    .unwrap_or_else(|| title_other(name))
            }
            ToolKind::Todo => {
                let count = args
                    .get("plan")
                    .or_else(|| args.get("todos"))
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                title_todo(count)
            }
            ToolKind::Read | ToolKind::Write | ToolKind::Edit => {
                match str_arg("path").or_else(|| str_arg("file_path")) {
                    Some(path) if kind == ToolKind::Read => {
                        let num = |k: &str| args.get(k).and_then(Value::as_u64);
                        let (title, range) = title_read(path, num("offset"), num("limit"));
                        detail = range;
                        title
                    }
                    Some(path) => title_path(path),
                    None => title_other(name),
                }
            }
            ToolKind::Web => ["query", "url", "q"]
                .iter()
                .find_map(|k| str_arg(k))
                .map(|q| title_web(&[q]))
                .unwrap_or_else(|| title_other(name)),
            _ => {
                detail = first_string_field(&args);
                title_other(name)
            }
        };
        let block = CallSpec {
            detail,
            server: normalized.server,
            input_ref: Some(span.content_ref("/payload/arguments")),
            ..CallSpec::new(call_id.clone(), name, kind, title, arguments)
        }
        .into_block();
        self.register_call(ts, owned(&p.id), call_id, block, flavor, cmds);
    }
    fn on_custom_call(&mut self, p: CustomCallPayload<'_>, ts: Option<i64>, span: JsonlSpan) {
        let name = opt_str(&p.name).unwrap_or("unknown");
        let input = opt_str(&p.input).unwrap_or_default();
        let call_id = owned(&p.call_id)
            .or_else(|| owned(&p.id))
            .unwrap_or_default();
        let mut spec = CallSpec {
            input_ref: Some(span.content_ref("/payload/input")),
            ..CallSpec::new(
                call_id.clone(),
                name,
                ToolKind::Other,
                title_other(name),
                input,
            )
        };
        let (flavor, cmds) = match name {
            "exec" => {
                let script = parse_exec_script(input);
                let (kind, title) = exec_title(&script, input);
                spec.kind = kind;
                spec.title = title;
                spec.detail = script.workdir.clone();
                spec.server = script.mcp.as_ref().map(|(server, _)| server.clone());
                (CallFlavor::Exec, script.cmds)
            }
            "apply_patch" => {
                let diff = diff_summary(
                    parse_apply_patch(input),
                    Some(span.content_ref("/payload/input")),
                );
                spec.kind = diff_kind(&diff);
                spec.title = diff_title(&diff);
                spec.diff = Some(diff);
                (CallFlavor::ApplyPatch, Vec::new())
            }
            _ => {
                let normalized = normalize_tool(ToolSource::Codex, name, None);
                spec.kind = normalized.kind;
                spec.server = normalized.server;
                (CallFlavor::Other, Vec::new())
            }
        };
        let block = spec.into_block();
        self.register_call(ts, owned(&p.id), call_id, block, flavor, cmds);
    }
    fn on_local_shell(&mut self, p: ActionPayload<'_>, ts: Option<i64>, span: JsonlSpan) {
        let action = p.action.unwrap_or(Value::Null);
        let cmd = action
            .get("command")
            .map(command_from_value)
            .unwrap_or_default();
        let input = action.to_string();
        let call_id = owned(&p.call_id)
            .or_else(|| owned(&p.id))
            .unwrap_or_default();
        let block = CallSpec {
            detail: action
                .get("working_directory")
                .and_then(Value::as_str)
                .map(str::to_string),
            input_ref: Some(span.content_ref("/payload/action")),
            ..CallSpec::new(
                call_id.clone(),
                "local_shell",
                refine_shell_kind(&cmd),
                title_shell(&cmd),
                &input,
            )
        }
        .into_block();
        let cmds = if cmd.is_empty() {
            Vec::new()
        } else {
            vec![cmd]
        };
        self.register_call(ts, owned(&p.id), call_id, block, CallFlavor::Shell, cmds);
    }
    fn on_item(&mut self, item: RawItem<'_>, ts: Option<i64>, span: JsonlSpan) {
        match item.ty.as_str() {
            "AgentMessage" => {
                if let (Some(id), Some(phase)) = (owned(&item.id), owned(&item.phase)) {
                    self.phases.insert(id, phase);
                }
                return;
            }
            "ContextCompaction" => {
                self.compaction_event(ts, None);
                return;
            }
            "WebSearch" => {
                self.last_web_search_id = owned(&item.id);
                return;
            }
            _ => {}
        }
        let item_id = owned(&item.id).unwrap_or_default();
        let Some(record) = item.into_record(span) else {
            return;
        };
        if let Some(call) = self.calls.get_mut(&item_id) {
            call.items.push(record);
            return;
        }
        if !item_id.is_empty() && self.finished.contains(&item_id) {
            if let ItemRecord::Command(info) = &record {
                self.backfill_finished_result(&item_id, info);
            }
            return;
        }
        let claim = match &record {
            ItemRecord::Command(info) => self.claim_command(info),
            ItemRecord::FileChange(_) => Claim::from(
                self.latest_open(&[CallFlavor::ApplyPatch])
                    .or_else(|| self.latest_open(&[CallFlavor::Exec])),
            ),
            ItemRecord::Mcp(_) | ItemRecord::Web(_) => {
                Claim::from(self.latest_open(&[CallFlavor::Exec]))
            }
            ItemRecord::ImageView { .. } => Claim::from(self.open.last().cloned()),
        };
        match (claim, record) {
            (Claim::Pool, ItemRecord::Command(info)) => self.pool.push(info),
            (Claim::Call(call_id), record) => match self.calls.get_mut(&call_id) {
                Some(call) => call.items.push(record),
                None => self.emit_standalone(record, ts),
            },
            (_, record) => self.emit_standalone(record, ts),
        }
    }
    fn latest_open(&self, flavors: &[CallFlavor]) -> Option<String> {
        self.open
            .iter()
            .rev()
            .find(|id| {
                self.calls
                    .get(*id)
                    .is_some_and(|c| flavors.contains(&c.flavor))
            })
            .cloned()
    }
    /// CommandExecution 归属：命令文本匹配的调用 → 唯一一个看不出命令的调用 →
    /// 多个看不出命令的调用（先放池子）→ 都不是（后台进程结束等，单独成块）
    fn claim_command(&self, info: &CommandInfo) -> Claim {
        let candidates: Vec<(&String, &PendingCall)> = self
            .open
            .iter()
            .rev()
            .filter_map(|id| self.calls.get(id).map(|c| (id, c)))
            .filter(|(_, c)| matches!(c.flavor, CallFlavor::Exec | CallFlavor::Shell))
            .collect();
        if let Some((id, _)) = candidates
            .iter()
            .find(|(_, c)| c.cmds.iter().any(|cmd| same_command(cmd, &info.command)))
        {
            return Claim::Call((*id).clone());
        }
        let unknown: Vec<&String> = candidates
            .iter()
            .filter(|(_, c)| c.cmds.is_empty())
            .map(|(id, _)| *id)
            .collect();
        match unknown.as_slice() {
            [] => Claim::None,
            [id] => Claim::Call((*id).clone()),
            _ => Claim::Pool,
        }
    }
    /// 迟到的 CommandExecution：把退出码、耗时补进已输出的结果（只补缺的字段）
    fn backfill_finished_result(&mut self, call_id: &str, info: &CommandInfo) {
        for message in self.messages.iter_mut().rev() {
            for block in message.blocks.iter_mut() {
                if let SessionBlock::ToolResult {
                    call_id: id,
                    status,
                    exit_code,
                    duration_ms,
                    ..
                } = block
                {
                    if id == call_id {
                        if exit_code.is_none() {
                            *exit_code = info.exit_code;
                        }
                        if duration_ms.is_none() {
                            *duration_ms = info.duration_ms;
                        }
                        if *status == ToolStatus::Success {
                            if matches!(info.status, ToolStatus::Error | ToolStatus::Interrupted) {
                                *status = info.status;
                            } else if exit_code.is_some_and(|c| c != 0) {
                                *status = ToolStatus::Error;
                            }
                        }
                        return;
                    }
                }
            }
        }
    }
    /// 找不到调用的结构化项：自己成一条助手消息（调用 + 结果）
    fn emit_standalone(&mut self, record: ItemRecord, ts: Option<i64>) {
        let (id, blocks) = match record {
            ItemRecord::Command(info) => {
                let blocks = vec![
                    info.call_spec().into_block(),
                    info.result_spec(info.id.clone()).into_block(),
                ];
                (info.id, blocks)
            }
            ItemRecord::FileChange(info) => {
                let call = CallSpec {
                    diff: Some(info.diff.clone()),
                    ..CallSpec::new(
                        info.id.clone(),
                        "FileChange",
                        diff_kind(&info.diff),
                        diff_title(&info.diff),
                        "",
                    )
                };
                let result = ResultSpec::empty(info.id.clone(), info.status);
                (info.id, vec![call.into_block(), result.into_block()])
            }
            ItemRecord::Mcp(info) => {
                let call = CallSpec {
                    detail: info.detail.clone(),
                    server: Some(info.server.clone()),
                    ..CallSpec::new(
                        info.id.clone(),
                        info.tool.clone(),
                        ToolKind::Mcp,
                        title_mcp(&info.server, &info.tool),
                        &info.input,
                    )
                };
                let result = ResultSpec {
                    output: info.output.clone(),
                    full: info.output_ref.clone(),
                    duration_ms: info.duration_ms,
                    images: info.images.clone(),
                    ..ResultSpec::empty(info.id.clone(), info.status)
                };
                let blocks = vec![call.into_block(), result.into_block()];
                (info.id, blocks)
            }
            ItemRecord::ImageView { id, path } => (
                id,
                vec![SessionBlock::Image {
                    image: local_image(&path),
                }],
            ),
            ItemRecord::Web(info) => {
                let call = CallSpec::new(
                    info.id.clone(),
                    "web_search",
                    ToolKind::Web,
                    info.title.clone(),
                    &info.input,
                );
                let result = ResultSpec::empty(info.id.clone(), ToolStatus::Success);
                let blocks = vec![call.into_block(), result.into_block()];
                (info.id, blocks)
            }
        };
        let id = (!id.is_empty()).then_some(id);
        self.push_assistant(ts, id, blocks);
    }
    fn flush_pool(&mut self, ts: Option<i64>) {
        for info in std::mem::take(&mut self.pool) {
            self.emit_standalone(ItemRecord::Command(info), ts);
        }
    }
    fn on_output(&mut self, p: OutputPayload<'_>, ts: Option<i64>, span: JsonlSpan) {
        let call_id = owned(&p.call_id).unwrap_or_default();
        let out = OutputInfo::from_contents(p.output.as_ref(), span);
        let id = owned(&p.id);
        match self.calls.remove(&call_id) {
            Some(call) => {
                self.open.retain(|c| *c != call_id);
                self.finish_call(call_id, call, Some(out), ts, id, false);
            }
            None => {
                let status = output_status(&out, None);
                let result = ResultSpec {
                    output: preview(&out.text),
                    full: out.full,
                    exit_code: out.exit_code,
                    duration_ms: out.duration_ms,
                    images: out.images,
                    ..ResultSpec::empty(call_id, status)
                };
                self.push("tool", ts, id, vec![result.into_block()], false);
            }
        }
    }
    /// 用挂上的结构化项回填调用块，并输出结果。
    /// `out = None` 时：`aborted` 为真输出中断结果，否则（文件末尾仍未完成）只回填调用块。
    fn finish_call(
        &mut self,
        call_id: String,
        call: PendingCall,
        out: Option<OutputInfo>,
        ts: Option<i64>,
        msg_id: Option<String>,
        aborted: bool,
    ) {
        self.finished.insert(call_id.clone());
        let PendingCall {
            msg_idx,
            block_idx,
            flavor,
            items,
            ..
        } = call;
        let is_shell = matches!(flavor, CallFlavor::Exec | CallFlavor::Shell);
        let patch_rejected = flavor == CallFlavor::ApplyPatch
            && out.as_ref().is_some_and(|o| apply_patch_rejected(&o.text));
        let mut commands = Vec::new();
        let mut file_change: Option<FileChangeInfo> = None;
        let mut mcp = None;
        let mut web = None;
        let mut views = Vec::new();
        for item in items {
            match item {
                ItemRecord::Command(info) => commands.push(info),
                ItemRecord::FileChange(info) => match &mut file_change {
                    Some(existing) => {
                        let mut files = std::mem::take(&mut existing.diff.files);
                        files.extend(info.diff.files);
                        existing.diff = diff_summary(files, None);
                    }
                    None => file_change = Some(info),
                },
                ItemRecord::Mcp(info) => mcp = Some(info),
                ItemRecord::Web(info) => web = Some(info),
                ItemRecord::ImageView { path, .. } => views.push(path),
            }
        }
        if let (Some(out), true, true) = (&out, is_shell, commands.is_empty()) {
            if let Some(pos) = self
                .pool
                .iter()
                .position(|c| !c.output_head.is_empty() && out.text.contains(&c.output_head))
            {
                commands.push(self.pool.remove(pos));
            }
        }
        if let Some(SessionBlock::ToolCall {
            kind,
            title,
            detail,
            server,
            diff,
            ..
        }) = self.messages[msg_idx].blocks.get_mut(block_idx)
        {
            if is_shell {
                if let [command] = commands.as_slice() {
                    *kind = command.kind;
                    *title = title_shell(&command.command);
                    *detail = command.cwd.clone().or(detail.take());
                } else if commands.is_empty() {
                    if let Some(fc) = &file_change {
                        *kind = diff_kind(&fc.diff);
                        *title = diff_title(&fc.diff);
                        *diff = Some(fc.diff.clone());
                    } else if let Some(m) = &mcp {
                        *kind = ToolKind::Mcp;
                        *title = title_mcp(&m.server, &m.tool);
                        *server = Some(m.server.clone());
                        *detail = m.detail.clone();
                    } else if let Some(w) = web.as_ref().filter(|w| !w.title.is_empty()) {
                        *kind = ToolKind::Web;
                        *title = w.title.clone();
                    }
                }
            } else if let (CallFlavor::ApplyPatch, Some(fc)) = (flavor, &file_change) {
                let mut merged = fc.diff.clone();
                if merged.full.is_none() {
                    merged.full = diff.as_ref().and_then(|d| d.full.clone());
                }
                *kind = diff_kind(&merged);
                *diff = Some(merged);
            }
            if patch_rejected {
                if let Some(diff) = diff {
                    diff.added = 0;
                    diff.removed = 0;
                    for file in &mut diff.files {
                        file.added = 0;
                        file.removed = 0;
                    }
                }
            }
        }
        let result_ids: Vec<String> = if is_shell && commands.len() > 1 {
            let template = self.messages[msg_idx].blocks[block_idx].clone();
            let subs: Vec<SessionBlock> = commands
                .iter()
                .enumerate()
                .map(|(k, command)| {
                    let mut block = template.clone();
                    if let SessionBlock::ToolCall {
                        id,
                        kind,
                        title,
                        detail,
                        ..
                    } = &mut block
                    {
                        *id = format!("{call_id}#{}", k + 1);
                        *kind = command.kind;
                        *title = title_shell(&command.command);
                        *detail = command.cwd.clone().or(detail.take());
                    }
                    block
                })
                .collect();
            self.messages[msg_idx]
                .blocks
                .splice(block_idx..=block_idx, subs);
            (1..=commands.len())
                .map(|k| format!("{call_id}#{k}"))
                .collect()
        } else {
            vec![call_id.clone()]
        };
        if out.is_none() && !aborted {
            return;
        }
        let mut results: Vec<SessionBlock> = Vec::new();
        if result_ids.len() > 1 {
            for (command, id) in commands.iter().zip(&result_ids) {
                if Some(id) == result_ids.last() {
                    break;
                }
                results.push(command.result_spec(id.clone()).into_block());
            }
        }
        let last_id = result_ids.last().cloned().unwrap_or(call_id);
        let last_command = if is_shell { commands.last() } else { None };
        let extra_status = file_change
            .as_ref()
            .map(|f| f.status)
            .or(mcp.as_ref().map(|m| m.status));
        let spec = match out {
            Some(out) => {
                let mut status = output_status(&out, last_command);
                if let Some(extra @ (ToolStatus::Error | ToolStatus::Interrupted)) = extra_status {
                    status = extra;
                }
                if patch_rejected {
                    status = ToolStatus::Error;
                }
                let images = if !out.images.is_empty() {
                    out.images
                } else {
                    let mut images = mcp.as_ref().map(|m| m.images.clone()).unwrap_or_default();
                    images.extend(views.iter().map(|p| local_image(p)));
                    images
                };
                ResultSpec {
                    output: preview(&out.text),
                    full: out.full,
                    exit_code: last_command.and_then(|c| c.exit_code).or(out.exit_code),
                    duration_ms: last_command
                        .and_then(|c| c.duration_ms)
                        .or(out.duration_ms)
                        .or(mcp.as_ref().and_then(|m| m.duration_ms)),
                    images,
                    ..ResultSpec::empty(last_id, status)
                }
            }
            None => match last_command {
                Some(command) => {
                    let mut spec = command.result_spec(last_id);
                    if matches!(spec.status, ToolStatus::Unknown | ToolStatus::Pending) {
                        spec.status = ToolStatus::Interrupted;
                    }
                    spec
                }
                None => ResultSpec::empty(last_id, ToolStatus::Interrupted),
            },
        };
        results.push(spec.into_block());
        self.push("tool", ts, msg_id, results, false);
    }
    fn finish(mut self) -> Vec<SessionMessage> {
        for call_id in std::mem::take(&mut self.open) {
            if let Some(call) = self.calls.remove(&call_id) {
                self.finish_call(call_id, call, None, None, None, false);
            }
        }
        self.flush_pool(None);
        self.flush_model_event();
        let mut final_by_turn: HashMap<&str, usize> = HashMap::new();
        for (idx, msg) in self.messages.iter().enumerate() {
            let has_text = msg
                .blocks
                .iter()
                .any(|b| matches!(b, SessionBlock::Text { .. }));
            if let (true, true, Some(turn)) = (msg.role == "assistant", has_text, &msg.turn_id) {
                final_by_turn.insert(turn.as_str(), idx);
            }
        }
        let targets: Vec<(String, usize)> = final_by_turn
            .into_iter()
            .map(|(turn, idx)| (turn.to_string(), idx))
            .collect();
        for (turn, idx) in targets {
            let model = self.turn_models.get(&turn).cloned();
            let usage = self.turn_usage.get(&turn).copied();
            if model.is_none() && usage.is_none() {
                continue;
            }
            let meta = self.messages[idx]
                .meta
                .get_or_insert_with(MessageMeta::default);
            meta.model = model;
            if let Some(usage) = usage {
                let nonzero = |n: u64| (n > 0).then_some(n);
                meta.input_tokens = Some(usage.input_tokens);
                meta.output_tokens = Some(usage.output_tokens);
                meta.cache_read_tokens = nonzero(usage.cached_input_tokens);
                meta.cache_write_tokens = nonzero(usage.cache_write_input_tokens);
                meta.reasoning_tokens = nonzero(usage.reasoning_output_tokens);
            }
        }
        let phases = std::mem::take(&mut self.phases);
        let mut messages = self.messages;
        for msg in &mut messages {
            if msg.role == "assistant" {
                if let Some(phase) = msg.id.as_ref().and_then(|id| phases.get(id)) {
                    let meta = msg.meta.get_or_insert_with(MessageMeta::default);
                    if meta.stop_reason.is_none() {
                        meta.stop_reason = Some(phase.clone());
                    }
                }
            }
            msg.content = project_content(&msg.blocks);
        }
        messages.retain(|m| !m.is_empty());
        messages
    }
}
enum Claim {
    Call(String),
    Pool,
    None,
}
impl From<Option<String>> for Claim {
    fn from(call_id: Option<String>) -> Self {
        call_id.map_or(Claim::None, Claim::Call)
    }
}
/// 结果状态：CommandExecution 的状态优先，其次输出头（Script failed / 非零退出码）
fn output_status(out: &OutputInfo, command: Option<&CommandInfo>) -> ToolStatus {
    let mut status = match command.map(|c| c.status) {
        Some(ToolStatus::Unknown | ToolStatus::Pending) | None => ToolStatus::Success,
        Some(status) => status,
    };
    let exit_code = command.and_then(|c| c.exit_code).or(out.exit_code);
    if status == ToolStatus::Success && (out.failed || exit_code.is_some_and(|c| c != 0)) {
        status = ToolStatus::Error;
    }
    status
}
/// 整段被同一个 XML 风格标签包住（`<recommended_plugins>…</recommended_plugins>` 之类）：
/// 是客户端注入的上下文，不是用户手打的提问
fn is_wrapped_in_tag(text: &str) -> bool {
    let Some(rest) = text.strip_prefix('<') else {
        return false;
    };
    let name: &str = rest
        .split(|c: char| c == '>' || c.is_whitespace())
        .next()
        .unwrap_or_default();
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        && text.ends_with(&format!("</{name}>"))
}
/// Codex 给图片包的 `<image name=…>` / `</image>` 标签行
fn is_image_wrapper(text: &str) -> bool {
    text == "</image>"
        || (text.starts_with("<image ") && text.ends_with('>') && !text.contains('\n'))
}
/// 列表元数据要读的行：开头取 id / 项目 / 首条消息，结尾取最后活跃时间与预览。
struct SessionLines {
    head: Vec<String>,
    tail: Vec<String>,
    /// 结尾没读到时间时的兜底（毫秒）
    fallback_last_active: Option<i64>,
}
fn extract_codex_prompt_from_ide_context(text: &str) -> Option<String> {
    let normalized = text.replace("\r\n", "\n");
    let lines = normalized.lines().collect::<Vec<_>>();
    let mut prompt: Option<String> = None;
    for (index, line) in lines.iter().enumerate() {
        let Some(inline_prompt) = codex_request_heading_payload(line) else {
            continue;
        };
        if !inline_prompt.is_empty() {
            prompt = Some(inline_prompt.to_string());
            continue;
        }
        let following_prompt = lines[index + 1..].join("\n").trim().to_string();
        prompt = (!following_prompt.is_empty()).then_some(following_prompt);
    }
    prompt
}
fn codex_request_heading_payload(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    if !trimmed.starts_with('#') {
        return None;
    }
    let heading = trimmed.trim_start_matches('#').trim_start();
    let lowered = heading.to_ascii_lowercase();
    if !lowered.starts_with(CODEX_REQUEST_MARKER) {
        return None;
    }
    let suffix = heading[CODEX_REQUEST_MARKER.len()..].trim_start();
    if suffix.is_empty() {
        return Some("");
    }
    let Some(separator) = suffix.chars().next() else {
        return Some("");
    };
    if !matches!(separator, ':' | '：' | '-' | '—') {
        return None;
    }
    Some(
        suffix
            .trim_start_matches(|c: char| c.is_whitespace() || matches!(c, ':' | '：' | '-' | '—'))
            .trim(),
    )
}
