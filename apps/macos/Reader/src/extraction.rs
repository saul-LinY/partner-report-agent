use crate::session_manager::model::{EventKind, SessionBlock, SessionMessage};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{BufRead, BufReader},
    path::Path,
    time::Instant,
};

#[derive(Deserialize)]
pub struct Manifest {
    pub authorized_root: String,
    pub jobs: Vec<Job>,
}
#[derive(Deserialize)]
pub struct Job {
    pub provider: String,
    pub session_id: String,
    pub source: String,
    pub project: String,
    pub allowed: bool,
    #[serde(default)]
    pub synthetic: bool,
}
#[derive(Default, Deserialize)]
struct GateRecord {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    id: Option<String>,
    #[serde(rename = "sessionId", default)]
    session_id: Option<String>,
    #[serde(default)]
    uuid: Option<String>,
    #[serde(default, deserialize_with = "crate::locate::map_only")]
    message: Option<GateMessage>,
    #[serde(rename = "relocatedCwd", default)]
    relocated_cwd: Option<String>,
    #[serde(default, deserialize_with = "crate::locate::map_only")]
    payload: Option<GatePayload>,
}
#[derive(Default, Deserialize)]
struct GateMessage {
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    model: Option<String>,
}
#[derive(Default, Deserialize)]
struct GatePayload {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    turn_id: Option<String>,
}
#[derive(Default)]
struct Gate {
    completed: HashSet<String>,
    cross_project: bool,
    records: usize,
    source_session_id: Option<String>,
    synthetic_message_ids: HashSet<String>,
    native_final_ids: HashSet<String>,
}
fn within(cwd: &str, root: &Path) -> bool {
    crate::locate::project_path(cwd).is_some_and(|actual| actual.starts_with(root))
}

fn opencode_message_dir(source: &Path, session_id: &str) -> Result<std::path::PathBuf, String> {
    let source = source.canonicalize().map_err(|_| "cannot resolve OpenCode metadata file")?;
    let session_root = source.parent().and_then(Path::parent).ok_or("invalid OpenCode storage layout")?;
    if session_root.file_name().and_then(|v| v.to_str()) != Some("session")
        || source.file_stem().and_then(|v| v.to_str()) != Some(session_id)
        || !crate::locate::valid_id(session_id)
    { return Err("invalid OpenCode session metadata path".into()); }
    let storage = session_root.parent().ok_or("invalid OpenCode storage root")?;
    Ok(storage.join("message").join(session_id))
}

// Match the retained legacy parser's file enumeration, rejecting symlink escapes
// before it can open any message or part content.
fn metadata_json_files(root: &Path) -> Result<Vec<std::path::PathBuf>, String> {
    if !root.exists() { return Ok(Vec::new()); }
    if fs::symlink_metadata(root).map_err(|_| "cannot inspect OpenCode directory")?.file_type().is_symlink() {
        return Err("OpenCode symbolic links are not supported".into());
    }
    let mut files = Vec::new();
    for entry in fs::read_dir(root).map_err(|_| "cannot enumerate OpenCode metadata")? {
        let entry = entry.map_err(|_| "cannot enumerate OpenCode metadata")?;
        let kind = entry.file_type().map_err(|_| "cannot inspect OpenCode metadata")?;
        if kind.is_symlink() { return Err("OpenCode symbolic links are not supported".into()); }
        if kind.is_dir() { files.extend(metadata_json_files(&entry.path())?); }
        else if entry.path().extension().and_then(|v| v.to_str()) == Some("json") { files.push(entry.path()); }
    }
    Ok(files)
}

fn gate_opencode_legacy(job: &Job, root: &Path) -> Result<Gate, String> {
    use crate::locate::{locate_file, read_json};
    let location = locate_file("opencode", Path::new(&job.source)).map_err(|e| e.message())?;
    if location.session_id != job.session_id { return Err("OpenCode session identity mismatch".into()); }
    let mut gate = Gate::default();
    gate.source_session_id = Some(location.session_id);
    gate.cross_project = !within(&location.cwd, root);
    if gate.cross_project { return Ok(gate); }
    let messages = opencode_message_dir(Path::new(&job.source), &job.session_id)?;
    let storage = messages.parent().and_then(Path::parent).ok_or("invalid OpenCode storage root")?;
    // The intermediate directories must not redirect enumeration either.
    for dir in [storage.join("message"), storage.join("part")] {
        if fs::symlink_metadata(dir).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("OpenCode symbolic links are not supported".into());
        }
    }
    for file in metadata_json_files(&messages)? {
        let meta = read_json(&file).map_err(|e| e.message())?;
        meta.check("opencode", Some(&job.session_id)).map_err(|e| e.message())?;
        let id = meta.id.as_deref().filter(|id| crate::locate::valid_id(id)).ok_or("OpenCode message ID missing")?;
        if meta.explicit_session_id("opencode").map_err(|e| e.message())? != Some(job.session_id.as_str())
            || file.file_stem().and_then(|v| v.to_str()) != Some(id)
        { return Err("OpenCode message identity mismatch".into()); }
        if meta.directories().iter().any(|cwd| !within(cwd, root)) {
            gate.cross_project = true; return Ok(gate);
        }
        for file in metadata_json_files(&storage.join("part").join(id))? {
            let part = read_json(&file).map_err(|e| e.message())?;
            part.check("opencode", Some(&job.session_id)).map_err(|e| e.message())?;
            if part.explicit_session_id("opencode").map_err(|e| e.message())? != Some(job.session_id.as_str())
                || part.message_id.as_deref() != Some(id)
                || part.id.as_deref() != file.file_stem().and_then(|v| v.to_str())
            { return Err("OpenCode part identity mismatch".into()); }
            if part.directories().iter().any(|cwd| !within(cwd, root)) {
                gate.cross_project = true; return Ok(gate);
            }
        }
    }
    Ok(gate)
}

fn gate_file(job: &Job, root: &Path) -> Result<Gate, String> {
    if job.provider == "opencode" && !job.source.starts_with("sqlite:") {
        return gate_opencode_legacy(job, root);
    }
    if job.provider == "grokbuild" {
        #[derive(Deserialize)] struct Summary { info: Info }
        #[derive(Deserialize)] struct Info { id: String, cwd: String }
        let path = Path::new(&job.source).canonicalize().map_err(|e|e.to_string())?;
        if path.file_name().and_then(|v|v.to_str()) != Some("summary.json") { return Err("invalid Grok summary path".into()); }
        let summary:Summary=serde_json::from_slice(&fs::read(&path).map_err(|e|e.to_string())?).map_err(|_|"invalid Grok session metadata")?;
        if summary.info.id!=job.session_id || path.parent().and_then(Path::file_name).and_then(|v|v.to_str())!=Some(job.session_id.as_str()) {return Err("Grok session identity mismatch".into());}
        let mut gate=Gate::default();gate.source_session_id=Some(summary.info.id);gate.cross_project=!within(&summary.info.cwd,root);
        if gate.cross_project{return Ok(gate);}
        #[derive(Deserialize)] struct Event { #[serde(rename="type")] kind:String, turn_number:Option<u64>, outcome:Option<String>, session_id:Option<String> }
        if let Ok(file)=fs::File::open(path.with_file_name("events.jsonl")) {
            let mut active=None;
            for line in BufReader::new(file).lines() {
                let line=line.map_err(|e|e.to_string())?;
                let Ok(event)=serde_json::from_str::<Event>(&line) else {continue;};
                if event.kind=="turn_started" {active=if event.session_id.as_deref()==Some(job.session_id.as_str()){event.turn_number}else{None};if let Some(number)=active{gate.completed.remove(&format!("t{}",number+1));}}
                if event.kind=="turn_ended" {
                    if let Some(number)=active.take(){let key=format!("t{}",number+1);if event.outcome.as_deref()==Some("completed"){gate.completed.insert(key);}else{gate.completed.remove(&key);}}
                }
            }
        }
        return Ok(gate);
    }
    if job.provider == "agy" {
        let path = Path::new(&job.source).canonicalize().map_err(|e| e.to_string())?;
        let session = path.parent().and_then(Path::parent).and_then(Path::parent).ok_or("invalid Antigravity transcript path")?;
        if session.file_name().and_then(|v| v.to_str()) != Some(job.session_id.as_str()) || session.join(".system_generated/logs/transcript_full.jsonl") != path { return Err("Antigravity source identity mismatch".into()); }
        let base = session.parent().and_then(Path::parent).ok_or("invalid Antigravity root")?;
        let conn = rusqlite::Connection::open_with_flags(base.join("conversation_summaries.db"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|e|e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(2)).map_err(|e|e.to_string())?;
        let columns = {
            let mut stmt = conn.prepare("PRAGMA table_info(conversation_summaries)").map_err(|_| "cannot inspect Antigravity schema")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(1)).map_err(|_| "cannot inspect Antigravity schema")?;
            rows.collect::<Result<HashSet<_>, _>>().map_err(|_| "cannot inspect Antigravity schema")?
        };
        let status_column = if columns.contains("status") { "status" } else { "NULL" };
        let busy_column = if columns.contains("not_fully_idle") { "not_fully_idle" } else { "NULL" };
        // Workspace and parent metadata remain mandatory for authorization.
        let (uris,status,busy,parent): (String,Option<String>,Option<i64>,Option<String>) = conn.query_row(&format!("SELECT workspace_uris,{status_column},{busy_column},parent_conversation_id FROM conversation_summaries WHERE conversation_id=?1"),[&job.session_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(|_|"Antigravity authorization metadata unavailable")?;
        if parent.is_some_and(|p|!p.is_empty()) { return Err("Antigravity child sessions are excluded".into()); }
        let paths: Vec<String> = serde_json::from_str(&uris).map_err(|_|"invalid Antigravity workspace metadata")?;
        let mut gate = Gate::default(); gate.source_session_id=Some(job.session_id.clone());
        gate.cross_project=paths.is_empty() || paths.iter().any(|s|url::Url::parse(s).ok().and_then(|u|u.to_file_path().ok()).is_none_or(|p|!within(&p.to_string_lossy(),root)));
        if gate.cross_project {return Ok(gate);}
        if status.is_none() || busy.is_none() { return Ok(gate); }
        let records=crate::session_manager::providers::agy::records(&path)?;
        let mut last=None;
        for record in records {
            if record["type"]=="USER_INPUT" {
                if let Some(id)=last.take(){gate.native_final_ids.insert(id);}
            } else if record["type"]=="PLANNER_RESPONSE" && record["status"]=="DONE" && record["content"].as_str().is_some_and(|s|!s.trim().is_empty()) {
                last=record["step_index"].as_u64().map(|n|n.to_string());
            }
        }
        if status.as_deref()==Some("CASCADE_RUN_STATUS_IDLE")&&busy==Some(0) {if let Some(id)=last{gate.native_final_ids.insert(id);}}
        return Ok(gate);
    }
    if job.source.starts_with("sqlite:") {
        let (database, id) = match job.provider.as_str() {
            "opencode" => {
                crate::session_manager::providers::opencode::parse_sqlite_source(&job.source)
            }
            "hermes" => crate::session_manager::providers::hermes::parse_sqlite_source(&job.source),
            _ => return Err("unsupported SQLite provider".into()),
        }
        .ok_or("invalid SQLite source")?;
        if id != job.session_id { return Err("SQLite session identity mismatch".into()); }
        let conn = rusqlite::Connection::open_with_flags(
            database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(2))
            .map_err(|e| e.to_string())?;
        let mut located = None;
        for table in if job.provider == "opencode" {
            vec!["session_v2", "session"]
        } else {
            vec!["sessions"]
        } {
            let columns = match conn.prepare(&format!("PRAGMA table_info({table})")) {
                Ok(mut stmt) => stmt
                    .query_map([], |r| r.get::<_, String>(1))
                    .map_err(|e| e.to_string())?
                    .collect::<Result<HashSet<_>, _>>()
                    .map_err(|e| e.to_string())?,
                Err(_) => continue,
            };
            let directories: Vec<_> = ["cwd", "directory"].into_iter().filter(|name| columns.contains(*name)).collect();
            if directories.is_empty() { continue; }
            let parents: Vec<_> = ["parent_id", "parent_session_id"].into_iter().filter(|name| columns.contains(*name)).collect();
            let selected: Vec<_> = directories.iter().chain(parents.iter()).copied().collect();
            let result = conn.query_row(
                &format!("SELECT {} FROM {table} WHERE id=?1", selected.join(",")),
                [&id],
                |r| {
                    let values = (0..selected.len()).map(|i| r.get::<_, Option<String>>(i)).collect::<Result<Vec<_>, _>>()?;
                    let (dirs, parents) = values.split_at(directories.len());
                    Ok((dirs.to_vec(), parents.to_vec()))
                },
            );
            match result {
                Ok(value) => {
                    located = Some(value);
                    break;
                }
                Err(rusqlite::Error::QueryReturnedNoRows) => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        let (directories, parents) = located.ok_or("source session metadata not found")?;
        if parents.iter().flatten().any(|p| !p.is_empty()) {
            return Err("child sessions are excluded".into());
        }
        let directories: Vec<_> = directories.iter().flatten().filter(|s| !s.is_empty()).collect();
        if directories.is_empty() { return Err("source session has no project metadata".into()); }
        let mut gate = Gate::default();
        gate.cross_project = directories.iter().any(|cwd| !within(cwd, root));
        gate.source_session_id = Some(id);
        return Ok(gate);
    }
    if !["codex", "claude", "pi", "omp", "hermes"].contains(&job.provider.as_str()) {
        return Err(
            "provider parser retained; authorized metadata discovery adapter not yet validated"
                .into(),
        );
    }
    let location = crate::locate::locate_file(&job.provider, Path::new(&job.source)).map_err(|e| e.message())?;
    if location.session_id != job.session_id { return Err("session identity mismatch".into()); }
    let mut gate = Gate::default();
    gate.source_session_id = Some(location.session_id);
    if !within(&location.cwd, root) { gate.cross_project = true; return Ok(gate); }
    let mut reader: Box<dyn BufRead> = if job.provider == "codex" {
        crate::codex_rollout_file::open_reader(Path::new(&job.source)).map_err(|e| e.to_string())?
    } else {
        Box::new(BufReader::new(
            fs::File::open(&job.source).map_err(|e| e.to_string())?,
        ))
    };
    let mut line = Vec::new();
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line).map_err(|_| "cannot read session metadata record")? == 0 { break; }
        if line.iter().all(u8::is_ascii_whitespace) { continue; }
        let Some(metadata) = crate::locate::parse_record(&line).map_err(|e| e.message())? else { break; };
        metadata.check(&job.provider, Some(&job.session_id)).map_err(|e| e.message())?;
        if metadata.directories().iter().any(|cwd| !within(cwd, root)) {
            gate.cross_project = true; return Ok(gate);
        }
        let Ok(record) = serde_json::from_slice::<GateRecord>(&line) else {
            continue;
        };
        gate.records += 1;
        if job.provider == "claude"
            && record.message.as_ref().is_some_and(|m| {
                m.role.as_deref() == Some("assistant") && m.model.as_deref() == Some("<synthetic>")
            })
        {
            if let Some(id) = record.uuid.clone() {
                gate.synthetic_message_ids.insert(id);
            }
        }
        if gate.source_session_id.is_none() {
            gate.source_session_id = record.session_id.clone().or_else(|| {
                if record.kind == "session" {
                    record.id.clone()
                } else {
                    None
                }
            });
        }
        if record.kind == "relocated" {
            if let Some(cwd) = record.relocated_cwd {
                if !within(&cwd, root) {
                    gate.cross_project = true;
                    return Ok(gate);
                }
            }
        }
        if let Some(payload) = record.payload {
            if record.kind == "session_meta" && gate.source_session_id.is_none() {
                gate.source_session_id = payload.id.clone();
            }
            if ["session_meta", "turn_context"].contains(&record.kind.as_str()) {
                if let Some(cwd) = payload.cwd {
                    if !within(&cwd, root) {
                        gate.cross_project = true;
                        return Ok(gate);
                    }
                }
            }
            if record.kind == "event_msg" && payload.kind == "task_complete" {
                if let Some(id) = payload.turn_id {
                    gate.completed.insert(id);
                }
            }
        }
    }
    Ok(gate)
}
fn text(message: &SessionMessage, from: usize) -> Vec<String> {
    message
        .blocks
        .iter()
        .skip(from)
        .filter_map(|block| match block {
            SessionBlock::Text { text, .. } if !text.trim().is_empty() => Some(text.clone()),
            _ => None,
        })
        .collect()
}
fn reason(message: &SessionMessage) -> Option<&str> {
    message.meta.as_ref().and_then(|m| m.stop_reason.as_deref())
}
fn candidate<'a>(messages: &[&'a SessionMessage]) -> Option<(usize, usize)> {
    let mut last_call = None;
    for (i, msg) in messages.iter().enumerate() {
        if msg.injected {
            continue;
        }
        for (j, block) in msg.blocks.iter().enumerate() {
            if matches!(block, SessionBlock::ToolCall { .. }) {
                last_call = Some((i, j));
            }
        }
    }
    for (i, msg) in messages.iter().enumerate().rev() {
        if msg.role != "assistant" || msg.injected {
            continue;
        }
        if last_call.is_some_and(|(last, _)| i < last) {
            return None;
        }
        let from = last_call
            .filter(|(last, _)| *last == i)
            .map_or(0, |(_, j)| j + 1);
        if !text(msg, from).is_empty() {
            return Some((i, from));
        }
    }
    None
}
fn extract(job: &Job, messages: &[SessionMessage], gate: &Gate) -> Vec<Value> {
    let mut groups: Vec<(String, Vec<&SessionMessage>)> = Vec::new();
    let mut generated = 0;
    for msg in messages {
        if msg.role == "user" && !msg.injected && !text(msg, 0).is_empty() {
            generated += 1;
        }
        let key = msg
            .turn_id
            .clone()
            .unwrap_or_else(|| format!("t{generated}"));
        if groups.last().is_none_or(|(last, _)| last != &key) {
            groups.push((key, Vec::new()));
        }
        groups.last_mut().unwrap().1.push(msg);
    }
    let mut results = Vec::new();
    for (key, msgs) in groups {
        let users: Vec<_> = msgs
            .iter()
            .filter(|m| m.role == "user" && !m.injected && !text(m, 0).is_empty())
            .copied()
            .collect();
        if users.is_empty() {
            continue;
        }
        let prompt_parts: Vec<_> = users.iter().flat_map(|m| text(m, 0)).collect();
        let stable_id = if job.provider == "codex" && msgs.iter().any(|m| m.turn_id.is_some()) {
            key.clone()
        } else {
            users[0].id.clone().unwrap_or(key.clone())
        };
        let aborted = msgs.iter().any(|m| {
            m.blocks.iter().any(|b| {
                matches!(
                    b,
                    SessionBlock::Event {
                        kind: EventKind::Aborted,
                        ..
                    }
                )
            })
        });
        let cand = candidate(&msgs);
        let explicit = msgs
            .iter()
            .enumerate()
            .rev()
            .find(|(_, m)| {
                m.role == "assistant"
                    && !m.injected
                    && reason(m) == Some("final_answer")
                    && !text(m, 0).is_empty()
            })
            .map(|(i, _)| (i, 0));
        let chosen = explicit.or(cand);
        let (final_parts, evidence, candidate_parts) = if let Some((i, from)) = chosen {
            let msg = msgs[i];
            let parts = text(msg, from);
            let stop = reason(msg).unwrap_or("");
            let diagnostic = msg
                .id
                .as_ref()
                .is_some_and(|id| gate.synthetic_message_ids.contains(id));
            let strong = explicit.is_some()
                || msg.id.as_ref().is_some_and(|id|gate.native_final_ids.contains(id))
                || (job.provider == "codex"
                    && gate.completed.contains(&key)
                    && stop != "commentary")
                || (job.provider == "grokbuild" && gate.completed.contains(&key) && stop != "tool_use")
                || (job.provider == "hermes"
                    && ["stop", "end_turn", "end-turn"].contains(&stop)
                    && !msg.blocks.iter().any(|b| matches!(b, SessionBlock::ToolCall { .. }))
                    && !msgs[i + 1..].iter().any(|m| !m.injected && ["assistant", "tool"].contains(&m.role.as_str())))
                || (["claude", "pi", "omp", "opencode"].contains(&job.provider.as_str())
                    && ["stop", "end_turn", "end-turn"].contains(&stop));
            if diagnostic {
                (Vec::new(), "provider_diagnostic", Vec::new())
            } else if !aborted && strong {
                (
                    parts,
                    if explicit.is_some() {
                        "explicit_final_phase"
                    } else if job.provider == "agy" {
                        "native_session_completion"
                    } else if job.provider == "grokbuild" {
                        "native_turn_completed"
                    } else if job.provider == "codex" {
                        "task_complete"
                    } else {
                        "native_stop_reason"
                    },
                    Vec::new(),
                )
            } else {
                (
                    Vec::new(),
                    if aborted {
                        "aborted"
                    } else if stop == "commentary" {
                        "commentary_rejected"
                    } else {
                        "heuristic_unconfirmed"
                    },
                    parts,
                )
            }
        } else {
            (
                Vec::new(),
                if aborted {
                    "aborted"
                } else {
                    "no_final_answer"
                },
                Vec::new(),
            )
        };
        let state = if final_parts.is_empty() {
            "incomplete"
        } else {
            "complete"
        };
        let content =
            json!({"prompt_parts":prompt_parts,"final_answer_parts":final_parts,"state":state});
        let hash = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&content).unwrap())
        );
        results.push(json!({"turn_id":stable_id,"upstream_turn_id":key,"source_prompt_ids":users.iter().map(|m|m.id.clone()).collect::<Vec<_>>(),"question_ts":users[0].ts,"answer_ts":chosen.and_then(|(i,_)|msgs[i].ts),"prompt_parts":content["prompt_parts"],"final_answer_parts":content["final_answer_parts"],"state":state,"evidence":evidence,"review_candidate_parts":candidate_parts,"candidate_stop_reason":chosen.and_then(|(i,_)|reason(msgs[i])),"model":chosen.and_then(|(i,_)|msgs[i].meta.as_ref().and_then(|m|m.model.clone())),"hash":hash}));
    }
    results
}
fn load(job: &Job) -> Result<Vec<SessionMessage>, String> {
    use crate::session_manager::providers::*;
    let p = Path::new(&job.source);
    match job.provider.as_str() {
        "codex" => codex::load_messages(p),
        "claude" => claude::load_messages(p),
        "pi" => pi::load_messages(p),
        "omp" => omp::load_messages(p),
        "opencode" if job.source.starts_with("sqlite:") => {
            opencode::load_messages_sqlite(&job.source)
        }
        "opencode" => opencode::load_messages(&opencode_message_dir(p, &job.session_id)?),
        "hermes" if job.source.starts_with("sqlite:") => hermes::load_messages_sqlite(&job.source),
        "hermes" => hermes::load_messages(p),
        "grokbuild" => grokbuild::load_messages(p),
        "agy" => agy::load_messages(p),
        _ => Err("unsupported provider".into()),
    }
}
fn native_texts(value: &Value) -> Vec<String> {
    if let Some(s) = value.as_str() {
        return vec![s.to_string()];
    }
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("text").and_then(Value::as_str).map(str::to_string))
        .collect()
}
fn parts_hash(parts: &[String]) -> String {
    format!("{:x}", Sha256::digest(serde_json::to_vec(parts).unwrap()))
}
// Independent raw-format check: compare accepted final text with native terminal
// messages, without using the upstream SessionMessage projection as an oracle.
fn audit_native(job: &Job, turns: &[Value]) -> Result<Value, String> {
    if !["codex", "claude", "omp", "pi"].contains(&job.provider.as_str()) {
        return Ok(json!({"applicable":false}));
    }
    let mut reader: Box<dyn BufRead> = if job.provider == "codex" {
        crate::codex_rollout_file::open_reader(Path::new(&job.source)).map_err(|e| e.to_string())?
    } else {
        Box::new(BufReader::new(
            fs::File::open(&job.source).map_err(|e| e.to_string())?,
        ))
    };
    let mut finals = HashSet::new();
    let mut phase_ids = HashSet::new();
    let mut assistant_records = Vec::new();
    let mut line = Vec::new();
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line).map_err(|_| "cannot read native audit record")? == 0 { break; }
        // The authorization gate has already rejected terminated bad records.
        // Parse bytes so a partial UTF-8 tail cannot fail the whole audit.
        let Ok(value) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        if job.provider == "codex" {
            let p = &value["payload"];
            if value["type"] == "event_msg"
                && p["type"] == "item_completed"
                && p["item"]["type"] == "AgentMessage"
                && p["item"]["phase"] == "final_answer"
            {
                if let Some(id) = p["item"]["id"].as_str() {
                    phase_ids.insert(id.to_string());
                }
            }
            if value["type"] == "response_item"
                && p["type"] == "message"
                && p["role"] == "assistant"
            {
                let parts = vec![native_texts(&p["content"]).join("\n")];
                assistant_records.push((
                    p["id"].as_str().unwrap_or("").to_string(),
                    p["phase"] == "final_answer",
                    parts_hash(&parts),
                ));
            }
        } else {
            let m = &value["message"];
            let stop = m["stopReason"]
                .as_str()
                .or_else(|| m["stop_reason"].as_str())
                .unwrap_or("");
            if m["role"] == "assistant" && ["stop", "end_turn", "end-turn"].contains(&stop) {
                finals.insert(parts_hash(&native_texts(&m["content"])));
            }
        }
    }
    for (id, explicit, hash) in assistant_records {
        if explicit || phase_ids.contains(&id) {
            finals.insert(hash);
        }
    }
    let mut checked = 0;
    let mut unmatched = 0;
    for turn in turns.iter().filter(|t| t["state"] == "complete") {
        if turn["evidence"] == "task_complete" {
            continue;
        }
        let parts: Vec<_> = turn["final_answer_parts"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        checked += 1;
        if !finals.contains(&parts_hash(&parts)) {
            unmatched += 1;
        }
    }
    Ok(
        json!({"applicable":true,"checked_complete_turns":checked,"unmatched_final_texts":unmatched}),
    )
}
pub fn extract_manifest(manifest: &Manifest) -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    let root = Path::new(&manifest.authorized_root).canonicalize()?;
    let mut output = Vec::new();
    for job in &manifest.jobs {
        let started = Instant::now();
        if !job.allowed || !within(&job.project, &root) {
            output.push(json!({"provider":job.provider,"session_id":job.session_id,"status":"blocked_before_open","synthetic":job.synthetic}));
            continue;
        }
        let gate = match gate_file(job, &root) {
            Ok(gate) => gate,
            Err(err) => {
                output.push(json!({"provider":job.provider,"session_id":job.session_id,"status":"metadata_error","error":err}));
                continue;
            }
        };
        if gate.cross_project {
            output.push(json!({"provider":job.provider,"session_id":job.session_id,"status":"cross_project_metadata_blocked"}));
            continue;
        }
        match load(job){
            Ok(messages)=>{
                let mut blocks=BTreeMap::<&str,usize>::new();
                for msg in &messages {for block in &msg.blocks {let k=match block {SessionBlock::Text{..}=>"text",SessionBlock::Thinking{..}=>"thinking",SessionBlock::ToolCall{..}=>"tool_call",SessionBlock::ToolResult{..}=>"tool_result",SessionBlock::Image{..}=>"image",SessionBlock::Event{..}=>"event",SessionBlock::Step{..}=>"step"};*blocks.entry(k).or_default()+=1;}}
                let turns=extract(job,&messages,&gate);
                let native_audit=audit_native(job,&turns).map_err(|e|format!("native audit: {e}"))?;
                output.push(json!({"provider":job.provider,"session_id":job.session_id,"source_session_id":gate.source_session_id,"status":"parsed","synthetic":job.synthetic,"source":job.source,"message_count":messages.len(),"injected_count":messages.iter().filter(|m|m.injected).count(),"blocks":blocks,"turns":turns,"native_audit":native_audit,"parse_ms":started.elapsed().as_millis()}));
            },
            // Parser diagnostics may embed native values. Only fixed text crosses the CLI boundary.
            Err(_)=>output.push(json!({"provider":job.provider,"session_id":job.session_id,"status":"parse_error","error":"session transcript parsing failed"})),
        }
    }
    Ok(output)
}
