// Derived from CC Switch 4.0.21 (6d6b716); MIT, Copyright (c) 2025 Jason Young.
// Session reading only. See UPSTREAM.json and LICENSE.
#![allow(dead_code, unused_imports)]
use super::blocks::{assign_turn_ids, openai_tool_calls, tool_result_block};
use super::utils::{
    extract_text, for_each_jsonl_value, parse_timestamp_to_ms, truncate_summary, TITLE_MAX_CHARS,
};
use crate::session_manager::model::{SessionBlock, ToolStatus, MessageMeta};
use crate::session_manager::SessionMessage;
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
#[derive(Debug, Deserialize)]
struct GrokSessionInfo {
    id: String,
    #[serde(default)]
    cwd: Option<String>,
}
#[derive(Debug, Deserialize)]
struct GrokSessionSummary {
    info: GrokSessionInfo,
    #[serde(default)]
    session_summary: Option<String>,
    #[serde(default)]
    generated_title: Option<String>,
    #[serde(default)]
    created_at: Option<Value>,
    #[serde(default)]
    updated_at: Option<Value>,
    #[serde(default)]
    last_active_at: Option<Value>,
}
/// `chat_history.jsonl`：`type ∈ {system, user, assistant, tool}`。
///
/// 会话的 sourcePath 是同目录的 `summary.json`；大内容的 Jsonl 引用指向 chat_history.jsonl
/// 的行（`content::resolve_content_ref` 对 grokbuild 固定改读该文件）。`tool` 记录的配对字段与
/// assistant 的 `tool_calls` 都是按 OpenAI 形状推断（待核实），缺失时 `callId` 为空串。
pub fn load_messages(path: &Path) -> Result<Vec<SessionMessage>, String> {
    let session_dir = path
        .parent()
        .ok_or_else(|| format!("Invalid Grok Build session path: {}", path.display()))?;
    let chat_path = session_dir.join("chat_history.jsonl");
    if !chat_path.is_file() {
        return Err(format!(
            "Failed to open Grok Build chat history: {}",
            chat_path.display()
        ));
    }
    let mut messages = Vec::new();
    #[derive(Deserialize)]
    struct Lifecycle { #[serde(rename="type")] kind:String, turn_number:Option<u64>, session_id:Option<String>, ts:Option<Value> }
    let mut timing=std::collections::HashMap::new();
    if let Ok(file)=std::fs::File::open(session_dir.join("events.jsonl")) {
        use std::io::BufRead;
        let mut current=None;
        for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
            let Ok(event)=serde_json::from_str::<Lifecycle>(&line) else {continue;};
            if event.kind=="turn_started" && event.session_id.as_deref()==session_dir.file_name().and_then(|v|v.to_str()) {
                current=event.turn_number;
                if let Some(number)=current{timing.insert(number,(event.ts.as_ref().and_then(parse_timestamp_to_ms),None));}
            } else if event.kind=="turn_ended" {
                if let Some(number)=current.take(){if let Some(entry)=timing.get_mut(&number){entry.1=event.ts.as_ref().and_then(parse_timestamp_to_ms);}}
            }
        }
    }
    let mut current_prompt=None;
    let mut physical_record=0usize;
    for_each_jsonl_value(&chat_path, |span, value| {
        physical_record+=1;
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        let role = match kind {
            "system" | "user" | "assistant" | "tool" => kind,
            "tool_result" => "tool",
            _ => return Ok(()),
        };
        // Native Grok user messages include environment/rules and reminders as user-role
        // records. Only prompt_index or user_query identifies a human prompt.
        let raw_text = value.get("content").map(extract_text).unwrap_or_default();
        let wrapped=raw_text.split_once("<user_query>").and_then(|(_,rest)|rest.split_once("</user_query>")).map(|(prompt,_)|prompt.trim());
        if role=="user" && (value.get("synthetic_reason").is_some() || (value.get("prompt_index").and_then(Value::as_u64).is_none() && wrapped.is_none())) {return Ok(());}
        if role=="user" {current_prompt=value.get("prompt_index").and_then(Value::as_u64);}
        let text=if role=="user"{wrapped.unwrap_or(&raw_text).to_string()}else{raw_text};
        let blocks = match role {
            "tool" => {
                vec![tool_result_block(
                    value
                        .get("tool_call_id")
                        .or_else(|| value.get("call_id"))
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    ToolStatus::Unknown,
                    &text,
                    || Some(span.content_ref("/content")),
                )]
            }
            "assistant" => {
                let mut blocks = Vec::new();
                if !text.trim().is_empty() {
                    blocks.push(SessionBlock::text(text));
                }
                let calls=value.get("tool_calls").and_then(Value::as_array).map(|calls|Value::Array(calls.iter().map(|call| {
                    if call.get("function").is_some(){call.clone()}else{serde_json::json!({"id":call["id"],"type":"function","function":{"name":call["name"],"arguments":call["arguments"]}})}
                }).collect()));
                blocks.extend(openai_tool_calls(calls.as_ref(), |pointer| {
                    Some(span.content_ref(format!("/tool_calls{pointer}")))
                }));
                blocks
            }
            _ if text.trim().is_empty() => Vec::new(),
            _ => vec![SessionBlock::text(text)],
        };
        let ts = value
            .get("timestamp")
            .or_else(|| value.get("ts"))
            .and_then(parse_timestamp_to_ms)
            .or_else(||current_prompt.and_then(|number|timing.get(&number)).and_then(|(start,end)|if role=="user"{*start}else if role=="assistant"{*end}else{None}));
        let mut message = SessionMessage::from_blocks(role, ts, blocks);
        message.id=Some(if role=="user" {value.get("prompt_index").and_then(Value::as_u64).map(|n|format!("prompt-{n}")).unwrap_or_else(||format!("record-{physical_record}"))}else{format!("record-{physical_record}")});
        if role=="assistant" {
            message.meta=Some(MessageMeta{model:value.get("model_id").and_then(Value::as_str).map(str::to_string),stop_reason:value.get("tool_calls").and_then(Value::as_array).filter(|c|!c.is_empty()).map(|_|"tool_use".to_string()),..Default::default()});
        }
        if message.is_empty() {
            return Ok(());
        }
        message.injected = role == "system";
        messages.push(message);
        Ok(())
    })?;
    assign_turn_ids(&mut messages);
    Ok(messages)
}
