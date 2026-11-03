// Derived from CC Switch 4.0.21 (6d6b716); MIT, Copyright (c) 2025 Jason Young.
// Session reading only. See UPSTREAM.json and LICENSE.
#![allow(dead_code, unused_imports)]
use crate::session_manager::model::ContentRef;
use chrono::{DateTime, FixedOffset};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

/// Maximum number of characters for session titles (shared across providers).
pub const TITLE_MAX_CHARS: usize = 80;
/// Read the first `head_n` lines and last `tail_n` lines from a file.
/// For small files (< 16 KB), reads all lines once to avoid unnecessary seeking.
pub fn read_head_tail_lines(
    path: &Path,
    head_n: usize,
    tail_n: usize,
) -> io::Result<(Vec<String>, Vec<String>)> {
    let file = File::open(path)?;
    let file_len = file.metadata()?.len();
    if file_len < 16_384 {
        let reader = BufReader::new(file);
        let all: Vec<String> = reader.lines().map_while(Result::ok).collect();
        let head = all.iter().take(head_n).cloned().collect();
        let skip = all.len().saturating_sub(tail_n);
        let tail = all.into_iter().skip(skip).collect();
        return Ok((head, tail));
    }
    let reader = BufReader::new(file);
    let head: Vec<String> = reader.lines().take(head_n).map_while(Result::ok).collect();
    let seek_pos = file_len.saturating_sub(16_384);
    let mut file2 = File::open(path)?;
    file2.seek(SeekFrom::Start(seek_pos))?;
    let tail_reader = BufReader::new(file2);
    let all_tail: Vec<String> = tail_reader.lines().map_while(Result::ok).collect();
    let skip_first = if seek_pos > 0 { 1 } else { 0 };
    let usable: Vec<String> = all_tail.into_iter().skip(skip_first).collect();
    let skip = usable.len().saturating_sub(tail_n);
    let tail = usable.into_iter().skip(skip).collect();
    Ok((head, tail))
}
pub fn parse_timestamp_to_ms(value: &Value) -> Option<i64> {
    if let Some(n) = value.as_i64() {
        return Some(if n > 1_000_000_000_000 { n } else { n * 1000 });
    }
    if let Some(n) = value.as_f64() {
        let n = n as i64;
        return Some(if n > 1_000_000_000_000 { n } else { n * 1000 });
    }
    let raw = value.as_str()?;
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|dt: DateTime<FixedOffset>| dt.timestamp_millis())
}
pub fn extract_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.to_string(),
        Value::Array(items) => items
            .iter()
            .filter_map(extract_text_from_item)
            .filter(|text| !text.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(map) => map
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        _ => String::new(),
    }
}
fn extract_text_from_item(item: &Value) -> Option<String> {
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
    if matches!(item_type, "tool_use" | "toolCall") {
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        return Some(format!("[Tool: {name}]"));
    }
    if item_type == "tool_result" {
        if let Some(content) = item.get("content") {
            let text = extract_text(content);
            if !text.is_empty() {
                return Some(text);
            }
        }
        return None;
    }
    if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
        return Some(text.to_string());
    }
    if let Some(text) = item.get("input_text").and_then(|v| v.as_str()) {
        return Some(text.to_string());
    }
    if let Some(text) = item.get("output_text").and_then(|v| v.as_str()) {
        return Some(text.to_string());
    }
    if let Some(content) = item.get("content") {
        let text = extract_text(content);
        if !text.is_empty() {
            return Some(text);
        }
    }
    None
}
pub fn truncate_summary(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let mut result = trimmed.chars().take(max_chars).collect::<String>();
    result.push_str("...");
    result
}
/// 一行 JSONL 在文件里的字节区间（含行尾 `\n`），生成 [`ContentRef::Jsonl`] 用。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct JsonlSpan {
    /// 行首的字节偏移
    pub offset: u64,
    /// 整行字节数，含行尾 `\n`（文件最后一行可能没有）
    pub len: u32,
}
impl JsonlSpan {
    /// 指向本行内 `pointer`（RFC 6901）处内容的引用
    pub fn content_ref(&self, pointer: impl Into<String>) -> ContentRef {
        ContentRef::Jsonl {
            offset: self.offset,
            len: self.len,
            pointer: pointer.into(),
        }
    }
}
/// JSONL 的一行及其字节区间。
pub struct LineSpan<'a> {
    pub span: JsonlSpan,
    /// 行内容，已去掉行尾 `\r\n` / `\n`
    pub bytes: &'a [u8],
}
/// 用 `read_until(b'\n')` 逐行读取并累计字节偏移，供需要回溯原文的解析器使用
/// （所有 JSONL 解析器共用这一份，`ContentRef::Jsonl` 的区间口径因此一致）。
///
/// 复用同一块缓冲区，不做 UTF-8 校验（交给 `serde_json::from_slice`），
/// 所以比 `BufRead::lines()` 少一次分配和一次校验。
pub struct LineSpans<R> {
    reader: R,
    buf: Vec<u8>,
    offset: u64,
}
impl<R: BufRead> LineSpans<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            buf: Vec::with_capacity(64 * 1024),
            offset: 0,
        }
    }
    /// 读取下一行；到文件末尾返回 `Ok(None)`。
    pub fn next_line(&mut self) -> io::Result<Option<LineSpan<'_>>> {
        self.buf.clear();
        let read = self.reader.read_until(b'\n', &mut self.buf)?;
        if read == 0 {
            return Ok(None);
        }
        let offset = self.offset;
        self.offset += read as u64;
        let mut end = self.buf.len();
        if end > 0 && self.buf[end - 1] == b'\n' {
            end -= 1;
            if end > 0 && self.buf[end - 1] == b'\r' {
                end -= 1;
            }
        }
        Ok(Some(LineSpan {
            span: JsonlSpan {
                offset,
                len: u32::try_from(read).unwrap_or(u32::MAX),
            },
            bytes: &self.buf[..end],
        }))
    }
}
/// 逐行读取 JSONL，跳过空行和无法解析的行，回调拿到 (字节区间, JSON)。
/// 回调返回 `Err` 时立即停止并向上传递。
pub fn for_each_jsonl_value(
    path: &Path,
    mut f: impl FnMut(JsonlSpan, Value) -> Result<(), String>,
) -> Result<(), String> {
    let file = File::open(path).map_err(|e| format!("Failed to open session file: {e}"))?;
    let mut lines = LineSpans::new(BufReader::new(file));
    while let Some(line) = lines
        .next_line()
        .map_err(|e| format!("Failed to read session file: {e}"))?
    {
        let bytes = line.bytes.trim_ascii();
        if bytes.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
            continue;
        };
        f(line.span, value)?;
    }
    Ok(())
}
pub fn path_basename(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = trimmed.trim_end_matches(['/', '\\']);
    let last = normalized
        .split(['/', '\\'])
        .next_back()
        .filter(|segment| !segment.is_empty())?;
    Some(last.to_string())
}
