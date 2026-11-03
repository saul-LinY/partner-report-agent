// Derived from CC Switch 4.0.21 (6d6b716); MIT, Copyright (c) 2025 Jason Young.
// Session reading only. See UPSTREAM.json and LICENSE.
#![allow(dead_code, unused_imports)]
use crate::session_manager::model::ToolKind;
use serde_json::Value;
/// 工具结果预览的最大行数
pub const PREVIEW_LINES: usize = 12;
/// 工具结果预览的最大字符数
pub const PREVIEW_CHARS: usize = 1200;
/// 工具参数预览的最大字符数（标题 / detail 已提炼出要点，参数只需看个开头；
/// 大会话里 Bash 参数预览曾占 payload 的五分之一）
pub const INPUT_PREVIEW_CHARS: usize = 400;
/// 思考正文预览的最大字符数
pub const THINKING_PREVIEW_CHARS: usize = 400;
/// 工具标题的最大字符数
pub const TITLE_CHARS: usize = 200;
/// Text 块超过该字符数时只下发预览 + 引用（注入的 AGENTS.md / developer / task-notification 等）
pub const INLINE_TEXT_MAX_CHARS: usize = 8 * 1024;
/// 压缩摘要等长事件说明的预览字符数
pub const EVENT_PREVIEW_CHARS: usize = 400;
/// 工具调用来自哪家 Agent；同名工具在不同 Agent 下归类可能不同。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolSource {
    Claude,
    Codex,
    OpenCode,
    /// Pi
    Pi,
    /// Hermes / Grok Build 等：按名称关键字推断
    Generic,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedTool {
    pub kind: ToolKind,
    /// MCP 服务器名（kind = Mcp 时）
    pub server: Option<String>,
}
impl NormalizedTool {
    fn of(kind: ToolKind) -> Self {
        Self { kind, server: None }
    }
    fn mcp(server: impl Into<String>) -> Self {
        Self {
            kind: ToolKind::Mcp,
            server: Some(server.into()),
        }
    }
}
/// 按 §3.3 的映射表把原始工具名归一化为 [`ToolKind`]。
///
/// `namespace` 只有 Codex `function_call.namespace` 会传（如 `mcp__cua_repl`）。
pub fn normalize_tool(
    source: ToolSource,
    raw_name: &str,
    namespace: Option<&str>,
) -> NormalizedTool {
    if let Some(server) = namespace.and_then(|ns| ns.strip_prefix("mcp__")) {
        return NormalizedTool::mcp(server.trim_end_matches('_'));
    }
    if let Some((server, _)) = split_mcp_name(raw_name) {
        return NormalizedTool::mcp(server);
    }
    use ToolKind::*;
    let kind = match source {
        ToolSource::Claude => match raw_name {
            "Bash" => Shell,
            "Read" => Read,
            "Grep" | "Glob" | "ToolSearch" | "ListAgents" => Search,
            "Edit" | "MultiEdit" | "NotebookEdit" => Edit,
            "Write" => Write,
            "WebFetch" | "WebSearch" => Web,
            "Agent" | "Task" | "SendMessage" | "TaskStop" => Agent,
            "AskUserQuestion" => Ask,
            "TodoWrite" => Todo,
            _ => Other,
        },
        ToolSource::Codex => match raw_name {
            "exec" | "exec_command" | "shell" | "local_shell" | "write_stdin"
            | "CommandExecution" => Shell,
            "read_file" => Read,
            "apply_patch" | "FileChange" => Edit,
            "write_file" => Write,
            "web_search" | "web_search_call" | "open_page" | "WebSearch" => Web,
            "McpToolCall" => Mcp,
            "spawn_agent" | "send_message" | "agent_message" | "SubAgentActivity"
            | "create_thread" => Agent,
            "request_user_input_async" => Ask,
            "update_plan" => Todo,
            name if name.starts_with("web.") => Web,
            _ => Other,
        },
        ToolSource::OpenCode => match raw_name {
            "bash" => Shell,
            "read" => Read,
            "grep" | "glob" | "list" | "ast_grep_search" | "codesearch" => Search,
            "edit" | "patch" => Edit,
            "write" => Write,
            "webfetch" | "websearch" => Web,
            "task" | "background_output" | "background_cancel" => Agent,
            "question" => Ask,
            "todowrite" | "todoread" => Todo,
            "invalid" => Other,
            name if name.contains('_') => {
                let server = name.split('_').next().unwrap_or_default();
                return NormalizedTool::mcp(server);
            }
            _ => Other,
        },
        ToolSource::Pi => match raw_name {
            "bash" | "bashExecution" => Shell,
            "read" => Read,
            "grep" | "find" | "ls" => Search,
            "edit" => Edit,
            "write" => Write,
            "fetch" => Web,
            _ => Other,
        },
        ToolSource::Generic => generic_kind(raw_name),
    };
    NormalizedTool::of(kind)
}
/// Hermes / Grok Build：没有固定工具表，按名称关键字推断。
fn generic_kind(raw_name: &str) -> ToolKind {
    let name = raw_name.to_ascii_lowercase();
    let has = |keys: &[&str]| keys.iter().any(|k| name.contains(k));
    if name.starts_with("web") {
        ToolKind::Web
    } else if has(&["shell", "bash", "exec", "terminal"]) {
        ToolKind::Shell
    } else if name.starts_with("read") {
        ToolKind::Read
    } else if has(&["grep", "glob", "search"]) {
        ToolKind::Search
    } else if has(&["edit", "patch"]) {
        ToolKind::Edit
    } else if name.starts_with("write") {
        ToolKind::Write
    } else {
        ToolKind::Other
    }
}
/// 拆 `mcp__<server>__<tool>`；不是这种形式返回 `None`。
pub fn split_mcp_name(raw_name: &str) -> Option<(&str, &str)> {
    let rest = raw_name.strip_prefix("mcp__")?;
    let (server, tool) = rest.split_once("__")?;
    (!server.is_empty() && !tool.is_empty()).then_some((server, tool))
}
/// Shell 命令按首个程序名细化：`rg`/`grep`/`fd`/`find`/`ls` 开头算搜索，其余仍是 Shell。
pub fn refine_shell_kind(command: &str) -> ToolKind {
    let program = command
        .split_whitespace()
        .next()
        .map(|p| p.rsplit('/').next().unwrap_or(p))
        .unwrap_or_default();
    match program {
        "rg" | "grep" | "fd" | "find" | "ls" => ToolKind::Search,
        _ => ToolKind::Shell,
    }
}
/// Codex `CommandExecution.parsed_cmd[].type` → kind（`unknown` 返回 `None`，保持 Shell）
pub fn kind_from_codex_parsed_cmd(parsed_type: &str) -> Option<ToolKind> {
    match parsed_type {
        "read" => Some(ToolKind::Read),
        "search" | "list" | "list_files" => Some(ToolKind::Search),
        _ => None,
    }
}
/// 截断后的预览与全文统计（长度均按字符计）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Preview {
    pub text: String,
    /// 全文字符数
    pub total_len: u32,
    /// 全文行数（空文本为 0；末尾换行不额外计一行）
    pub line_count: u32,
    /// 预览是否短于全文（忽略末尾换行）
    pub truncated: bool,
}
/// 工具结果预览：前 [`PREVIEW_LINES`] 行且不超过 [`PREVIEW_CHARS`] 字符。
pub fn preview(text: &str) -> Preview {
    preview_with(text, PREVIEW_LINES, PREVIEW_CHARS)
}
/// 只按字符截断（参数、思考正文）。
pub fn preview_chars(text: &str, max_chars: usize) -> Preview {
    preview_with(text, usize::MAX, max_chars)
}
pub fn preview_with(text: &str, max_lines: usize, max_chars: usize) -> Preview {
    let total_len = saturating_u32(text.chars().count());
    let line_count = saturating_u32(text.lines().count());
    let mut end = text.len();
    if max_lines > 0 {
        if let Some((idx, _)) = text.match_indices('\n').nth(max_lines - 1) {
            end = idx;
        }
    } else {
        end = 0;
    }
    if let Some((idx, _)) = text[..end].char_indices().nth(max_chars) {
        end = idx;
    }
    let truncated = !text[end..].trim_end_matches(['\r', '\n']).is_empty();
    let kept = text[..end].trim_end_matches(['\r', '\n']);
    Preview {
        text: kept.to_string(),
        total_len,
        line_count,
        truncated,
    }
}
pub(super) fn saturating_u32(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}
/// base64 长度 → 解码后字节数估算（`ImageRef.size`）
pub fn estimate_base64_size(base64_len: usize) -> u32 {
    saturating_u32(base64_len / 4 * 3)
}
/// 截成单行标题：取首个非空行，超过 [`TITLE_CHARS`] 或有后续行时加 `…`。
pub fn one_line_title(text: &str) -> String {
    let trimmed = text.trim();
    let mut lines = trimmed.lines();
    let first = lines.next().unwrap_or_default().trim_end();
    let more_lines = lines.any(|line| !line.trim().is_empty());
    let mut title: String = first.chars().take(TITLE_CHARS).collect();
    if more_lines || first.chars().count() > TITLE_CHARS {
        title.push('…');
    }
    title
}
/// shell：命令文本首行。Codex 的 shell 包装去除、exec JS 中取 cmd 等由 P1b 补充。
pub fn title_shell(command: &str) -> String {
    one_line_title(command)
}
/// read：标题为路径；`detail` 为行范围 `:start-end`（offset 从 1 起算，limit 为行数）。
pub fn title_read(path: &str, offset: Option<u64>, limit: Option<u64>) -> (String, Option<String>) {
    let detail = match (offset, limit) {
        (Some(start), Some(limit)) if limit > 0 => Some(format!(":{start}-{}", start + limit - 1)),
        (Some(start), None) => Some(format!(":{start}")),
        (None, Some(limit)) if limit > 0 => Some(format!(":1-{limit}")),
        _ => None,
    };
    (one_line_title(path), detail)
}
/// search：`pattern in path`（没有 path 时只给 pattern）。
pub fn title_search(pattern: &str, path: Option<&str>) -> String {
    match path.filter(|p| !p.is_empty()) {
        Some(path) => one_line_title(&format!("{pattern} in {path}")),
        None => one_line_title(pattern),
    }
}
/// edit / write：路径。
pub fn title_path(path: &str) -> String {
    one_line_title(path)
}
/// web：URL 或 query；多个用 `, ` 连接。
pub fn title_web(items: &[&str]) -> String {
    one_line_title(&items.join(", "))
}
/// mcp：`server.tool`。
pub fn title_mcp(server: &str, tool: &str) -> String {
    one_line_title(&format!("{server}.{tool}"))
}
/// agent：description / task_name。
pub fn title_agent(description: &str) -> String {
    one_line_title(description)
}
/// ask：首个问题文本。
pub fn title_ask(question: &str) -> String {
    one_line_title(question)
}
/// todo：条目数。
pub fn title_todo(count: usize) -> String {
    format!("{count} 项")
}
/// other：原名。
pub fn title_other(raw_name: &str) -> String {
    one_line_title(raw_name)
}
/// 参数里第一个非空字符串字段（mcp / other 的 `detail`）。
pub fn first_string_field(input: &Value) -> Option<String> {
    input
        .as_object()?
        .values()
        .find_map(|v| v.as_str().filter(|s| !s.trim().is_empty()))
        .map(one_line_title)
}
use crate::session_manager::model::{
    ContentRef, DiffFile, DiffOp, DiffSummary, EventKind, SessionBlock, SessionMessage, ToolStatus,
};
/// 参数里第一个存在的非空字符串字段。
pub fn str_field<'a>(input: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| input.get(*key).and_then(Value::as_str))
        .filter(|s| !s.trim().is_empty())
}
/// 参数里第一个存在的非负整数字段（兼容写成字符串的数字）。
fn u64_field(input: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter().find_map(|key| {
        let value = input.get(*key)?;
        value
            .as_u64()
            .or_else(|| value.as_str().and_then(|s| s.trim().parse().ok()))
    })
}
/// OpenAI 形状的 `arguments` 是 JSON 字符串：能解析成对象/数组就解析，否则保持原样。
pub fn parse_arguments(raw: &Value) -> Value {
    match raw {
        Value::String(text) => match serde_json::from_str::<Value>(text) {
            Ok(parsed @ (Value::Object(_) | Value::Array(_))) => parsed,
            _ => raw.clone(),
        },
        other => other.clone(),
    }
}
/// 工具参数预览：字符串原样，其余序列化为紧凑 JSON；空参数为空串。
pub fn input_preview(input: &Value) -> Preview {
    match input {
        Value::Null => preview_chars("", INPUT_PREVIEW_CHARS),
        Value::String(text) => preview_chars(text, INPUT_PREVIEW_CHARS),
        other => preview_chars(&other.to_string(), INPUT_PREVIEW_CHARS),
    }
}
const PATH_KEYS: &[&str] = &[
    "file_path",
    "filePath",
    "path",
    "absolute_path",
    "file",
    "filename",
    "dir_path",
];
/// 按 kind 从参数里提炼 `(title, detail)`（§3.3）。找不到对应字段时 title 为空，
/// 投影退化为 `[Tool: name]`。
pub fn title_from_input(
    kind: ToolKind,
    raw_name: &str,
    server: Option<&str>,
    input: &Value,
) -> (String, Option<String>) {
    let detail_of = |keys: &[&str]| str_field(input, keys).map(one_line_title);
    match kind {
        ToolKind::Shell => (
            str_field(input, &["command", "cmd", "script"])
                .map(title_shell)
                .unwrap_or_default(),
            detail_of(&["description"]),
        ),
        ToolKind::Read => {
            if let Some(path) = str_field(input, PATH_KEYS) {
                title_read(
                    path,
                    u64_field(input, &["offset", "start_line"]),
                    u64_field(input, &["limit"]),
                )
            } else {
                let paths: Vec<&str> = input
                    .get("paths")
                    .and_then(Value::as_array)
                    .map(|items| items.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                (title_web(&paths), None)
            }
        }
        ToolKind::Search => {
            let path = str_field(input, &["path", "dir_path", "directory", "cwd"]);
            match str_field(input, &["pattern", "query", "regex", "glob", "include"]) {
                Some(pattern) => (title_search(pattern, path), None),
                None => (path.map(title_path).unwrap_or_default(), None),
            }
        }
        ToolKind::Edit | ToolKind::Write => (
            str_field(input, PATH_KEYS)
                .map(title_path)
                .unwrap_or_default(),
            None,
        ),
        ToolKind::Web => {
            let mut items: Vec<&str> = ["urls", "queries"]
                .iter()
                .filter_map(|key| input.get(*key).and_then(Value::as_array))
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            if items.is_empty() {
                items.extend(str_field(input, &["url", "query", "prompt"]));
            }
            (title_web(&items), None)
        }
        ToolKind::Mcp => {
            let server = server.unwrap_or_default();
            let tool = split_mcp_name(raw_name)
                .map(|(_, tool)| tool)
                .or_else(|| {
                    raw_name
                        .strip_prefix(server)
                        .map(|rest| rest.trim_start_matches(['_', '/', '.']))
                })
                .filter(|tool| !tool.is_empty())
                .unwrap_or(raw_name);
            (title_mcp(server, tool), first_string_field(input))
        }
        ToolKind::Agent => (
            str_field(input, &["description", "task_name", "prompt", "message"])
                .map(title_agent)
                .unwrap_or_default(),
            detail_of(&["subagent_type", "agent", "model"]),
        ),
        ToolKind::Ask => {
            let question = input
                .get("questions")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|first| {
                    first
                        .get("question")
                        .and_then(Value::as_str)
                        .or_else(|| first.as_str())
                })
                .or_else(|| str_field(input, &["question", "prompt"]));
            (question.map(title_ask).unwrap_or_default(), None)
        }
        ToolKind::Todo => {
            let count = input.get("todos").and_then(Value::as_array).map(Vec::len);
            (count.map(title_todo).unwrap_or_default(), None)
        }
        ToolKind::Other => (title_other(raw_name), first_string_field(input)),
    }
}
/// 文本行数（空文本为 0）。
fn text_lines(text: &str) -> u32 {
    saturating_u32(text.lines().count())
}
/// 统计 unified diff（或带行号的 `+12 xxx` 形式）里的增删行数，跳过 `+++`/`---` 文件头。
pub fn count_diff_lines(diff: &str) -> (u32, u32) {
    let (mut added, mut removed) = (0u32, 0u32);
    for line in diff.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if line.starts_with('+') {
            added = added.saturating_add(1);
        } else if line.starts_with('-') {
            removed = removed.saturating_add(1);
        }
    }
    (added, removed)
}
/// 单文件改动摘要。
pub fn single_file_diff(path: &str, op: DiffOp, added: u32, removed: u32) -> DiffSummary {
    DiffSummary {
        files: vec![DiffFile {
            path: path.to_string(),
            op,
            added,
            removed,
        }],
        added,
        removed,
        full: None,
    }
}
/// 只凭参数估算 Edit/Write 的改动（`old/new` 字符串按行数计、`edits[]` 求和、`content` 视为新增）。
/// 拿到工具自己给的 diff 时应以那个为准。
pub fn diff_from_input(kind: ToolKind, input: &Value) -> Option<DiffSummary> {
    let path = str_field(input, PATH_KEYS)?;
    let pair = |item: &Value| -> Option<(u32, u32)> {
        let old = str_field_allow_empty(item, &["old_string", "oldString", "old_str", "oldText"])?;
        let new = str_field_allow_empty(item, &["new_string", "newString", "new_str", "newText"])?;
        Some((text_lines(new), text_lines(old)))
    };
    match kind {
        ToolKind::Edit => {
            let (added, removed) = if let Some(edits) = input.get("edits").and_then(Value::as_array)
            {
                edits
                    .iter()
                    .filter_map(pair)
                    .fold((0u32, 0u32), |(a, r), (x, y)| {
                        (a.saturating_add(x), r.saturating_add(y))
                    })
            } else {
                pair(input)?
            };
            Some(single_file_diff(path, DiffOp::Update, added, removed))
        }
        ToolKind::Write => {
            let content = str_field_allow_empty(input, &["content", "contents", "text"])?;
            Some(single_file_diff(path, DiffOp::Add, text_lines(content), 0))
        }
        _ => None,
    }
}
fn str_field_allow_empty<'a>(input: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| input.get(*key).and_then(Value::as_str))
}
/// OpenAI 形状的 `tool_calls[]`（`{id, function{name, arguments}}`，也兼容扁平 `{id, name, arguments}`）
/// → ToolCall。`arguments_ref(pointer)` 为参数全文生成引用，`pointer` 是参数在 `tool_calls`
/// 数组内的 JSON Pointer（`/{i}/function/arguments` 或扁平形状的 `/{i}/arguments`）。
pub(super) fn openai_tool_calls(
    calls: Option<&Value>,
    arguments_ref: impl Fn(String) -> Option<ContentRef>,
) -> Vec<SessionBlock> {
    calls
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(i, call)| {
            let name = call
                .pointer("/function/name")
                .or_else(|| call.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let id = call.get("id").and_then(Value::as_str).unwrap_or_default();
            let (pointer, raw) = match call.pointer("/function/arguments") {
                Some(raw) => (format!("/{i}/function/arguments"), Some(raw)),
                None => (format!("/{i}/arguments"), call.get("arguments")),
            };
            let input = raw.map(parse_arguments).unwrap_or(Value::Null);
            tool_call_block(ToolSource::Generic, id, name, &input, || {
                arguments_ref(pointer)
            })
        })
        .collect()
}
/// 由参数构造 `ToolCall`：归一化 kind、提炼标题、参数预览；参数超长时调用 `input_full` 生成引用。
/// Edit/Write 先按参数估算 diff，解析器拿到更准的数据再覆盖。
pub fn tool_call_block(
    source: ToolSource,
    id: impl Into<String>,
    raw_name: &str,
    input: &Value,
    input_full: impl FnOnce() -> Option<ContentRef>,
) -> SessionBlock {
    let NormalizedTool { kind, server } = normalize_tool(source, raw_name, None);
    let (title, detail) = title_from_input(kind, raw_name, server.as_deref(), input);
    let preview = input_preview(input);
    SessionBlock::ToolCall {
        id: id.into(),
        raw_name: raw_name.to_string(),
        kind,
        title,
        detail,
        server,
        input_preview: preview.text,
        input_total_len: preview.total_len,
        input_full: if preview.truncated {
            input_full()
        } else {
            None
        },
        diff: diff_from_input(kind, input),
        by_user: false,
    }
}
/// 构造 `ToolResult`：预览 12 行 / 1200 字，超出时调用 `full` 生成引用。
/// `exit_code` / `duration_ms` / `images` / `saved_path` 由解析器按需补上。
pub fn tool_result_block(
    call_id: impl Into<String>,
    status: ToolStatus,
    text: &str,
    full: impl FnOnce() -> Option<ContentRef>,
) -> SessionBlock {
    let p = preview(text);
    SessionBlock::ToolResult {
        call_id: call_id.into(),
        status,
        preview: p.text,
        total_len: p.total_len,
        line_count: p.line_count,
        truncated: p.truncated,
        full: if p.truncated { full() } else { None },
        exit_code: None,
        duration_ms: None,
        images: Vec::new(),
        saved_path: None,
    }
}
/// 构造 `Thinking`：正文按 [`THINKING_PREVIEW_CHARS`] 截断，超出时调用 `full` 生成引用；
/// 正文为空视为不可见（redacted）。
pub fn thinking_block(
    text: &str,
    summary: Option<String>,
    duration_ms: Option<u64>,
    full: impl FnOnce() -> Option<ContentRef>,
) -> SessionBlock {
    let p = preview_chars(text.trim_end(), THINKING_PREVIEW_CHARS);
    SessionBlock::Thinking {
        redacted: text.trim().is_empty(),
        text: p.text,
        summary,
        duration_ms,
        full: if p.truncated { full() } else { None },
    }
}
/// 构造 `Text`：超过 [`INLINE_TEXT_MAX_CHARS`] 且能给出引用时只放预览（12 行 / 1200 字）+ `full`。
/// 只用于默认折叠的内容（注入文本）；真人提问与最终回复要完整渲染 Markdown，不走这里。
pub fn large_text_block(
    text: impl Into<String>,
    full: impl FnOnce() -> Option<ContentRef>,
) -> SessionBlock {
    let text = text.into();
    if text.chars().nth(INLINE_TEXT_MAX_CHARS).is_none() {
        return SessionBlock::text(text);
    }
    match full() {
        Some(full) => SessionBlock::Text {
            text: preview(&text).text,
            full: Some(full),
        },
        None => SessionBlock::text(text),
    }
}
/// 构造带长说明的 `Event`（压缩摘要）：超过 [`EVENT_PREVIEW_CHARS`] 且能给出引用时只放预览 + `full`；
/// 拿不到引用时退回带 `…` 的预览，避免把整段摘要塞进 payload。
pub fn summary_event_block(
    kind: EventKind,
    text: &str,
    full: impl FnOnce() -> Option<ContentRef>,
) -> SessionBlock {
    let text = text.trim();
    let p = preview_chars(text, EVENT_PREVIEW_CHARS);
    if !p.truncated {
        return SessionBlock::event(kind, Some(p.text), None);
    }
    match full() {
        Some(full) => SessionBlock::Event {
            kind,
            text: Some(p.text),
            url: None,
            full: Some(full),
        },
        None => SessionBlock::event(kind, Some(format!("{}…", p.text)), None),
    }
}
/// 这条消息是否开启新一轮：非注入的 user 消息，且带真人输入——非空文本、图片或斜杠命令。
/// 只有中断事件、用户自己跑的命令（Claude `!cmd`、Pi bashExecution）或工具结果的
/// user 消息不开新轮，归入当前轮。旧格式消息（无 blocks）看 `content` 是否非空。
pub fn starts_turn(message: &SessionMessage) -> bool {
    if message.role != "user" || message.injected {
        return false;
    }
    if message.blocks.is_empty() {
        return !message.content.trim().is_empty();
    }
    message.blocks.iter().any(|block| match block {
        SessionBlock::Text { text, .. } => !text.trim().is_empty(),
        SessionBlock::Image { .. } => true,
        SessionBlock::Event { kind, .. } => *kind == EventKind::SlashCommand,
        _ => false,
    })
}
/// 没有原生轮次概念的解析器共用（§4）：按 [`starts_turn`] 递增生成 `t{n}`，
/// 首条提问之前的内容归 `t0`。已有 `turn_id` 的消息保持不变。
pub fn assign_turn_ids(messages: &mut [SessionMessage]) {
    let mut turn = 0u32;
    for message in messages {
        if starts_turn(message) {
            turn += 1;
        }
        if message.turn_id.is_none() {
            message.turn_id = Some(format!("t{turn}"));
        }
    }
}
/// 由替换前后的文本估算 `(+added, -removed)` 行数：去掉首尾相同的行后，
/// 剩余的旧行算删除、新行算新增。没有结构化 patch 时（如 Claude Edit 的参数）用。
pub fn line_change_counts(old: &str, new: &str) -> (u32, u32) {
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();
    let prefix = old_lines
        .iter()
        .zip(&new_lines)
        .take_while(|(a, b)| a == b)
        .count();
    let suffix = old_lines[prefix..]
        .iter()
        .rev()
        .zip(new_lines[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    (
        saturating_u32(new_lines.len() - prefix - suffix),
        saturating_u32(old_lines.len() - prefix - suffix),
    )
}
