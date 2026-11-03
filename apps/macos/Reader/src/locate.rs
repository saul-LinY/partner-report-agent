//! Metadata-only discovery. Never deserialize titles, prompts, or message content.
use serde::{
    de::{value::MapAccessDeserializer, IgnoredAny, MapAccess, SeqAccess, Visitor},
    Deserialize, Serialize,
};
use std::{
    fs::File,
    io::{BufRead, BufReader, Read},
    path::{Component, Path, PathBuf},
};

// Match the former Swift discovery budget: Claude's first user record may
// contain a large prompt alongside the location fields we actually project.
const MAX_METADATA_BYTES: usize = 8 * 1024 * 1024;

#[derive(Deserialize)]
pub struct LocateRequest {
    pub provider: String,
    pub source: String,
}

#[derive(Serialize)]
pub struct LocateResult {
    pub provider: String,
    pub source: String,
    pub status: &'static str,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'static str>,
}

pub(crate) enum MetadataError {
    Invalid(&'static str),
    Excluded,
}

impl MetadataError {
    pub(crate) fn message(&self) -> &'static str {
        match self {
            Self::Invalid(message) => message,
            Self::Excluded => "child sessions are excluded",
        }
    }
}

#[derive(Debug)]
pub(crate) struct Location {
    pub session_id: String,
    pub cwd: String,
}

// Separate fields deliberately detect conflicting aliases instead of choosing one.
// Unknown JSON values are skipped by serde, not projected into a serde_json::Value.
#[derive(Default, Deserialize)]
pub(crate) struct Metadata {
    #[serde(rename = "type")]
    pub kind: Option<String>,
    #[serde(default, deserialize_with = "optional_id")]
    pub id: Option<String>,
    #[serde(rename = "sessionId")]
    session_id_camel: Option<String>,
    #[serde(rename = "sessionID")]
    pub session_id_upper: Option<String>,
    pub session_id: Option<String>,
    #[serde(rename = "messageID")]
    pub message_id: Option<String>,
    pub cwd: Option<String>,
    pub directory: Option<String>,
    #[serde(rename = "workDir")]
    work_dir: Option<String>,
    #[serde(rename = "relocatedCwd")]
    relocated_cwd: Option<String>,
    #[serde(rename = "parentID")]
    parent_id_upper: Option<String>,
    #[serde(rename = "parentId")]
    parent_id_camel: Option<String>,
    parent_id: Option<String>,
    parent_session_id: Option<String>,
    #[serde(rename = "parentSessionId")]
    parent_session_id_camel: Option<String>,
    #[serde(rename = "parentSession")]
    parent_session: Option<String>,
    parent_thread_id: Option<String>,
    #[serde(rename = "agentId")]
    agent_id_camel: Option<String>,
    agent_id: Option<String>,
    #[serde(rename = "isSidechain")]
    is_sidechain_camel: Option<bool>,
    is_sidechain: Option<bool>,
    #[serde(rename = "isSubagent")]
    is_subagent_camel: Option<bool>,
    is_subagent: Option<bool>,
    session_kind: Option<String>,
    source: Option<Origin>,
    #[serde(default, deserialize_with = "map_only")]
    pub payload: Option<Box<Metadata>>,
    #[serde(default, deserialize_with = "map_only")]
    info: Option<Box<Metadata>>,
    #[serde(default, deserialize_with = "map_only")]
    message: Option<Box<Metadata>>,
    #[serde(default, deserialize_with = "map_only")]
    custom: Option<Box<Metadata>>,
    #[serde(default, deserialize_with = "map_only")]
    path: Option<ProjectPaths>,
}

// Event containers can also be body scalars/arrays. Project only maps, without
// materializing body values. Known metadata fields within maps stay strict.
pub(crate) fn map_only<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    struct MapOnly<T>(std::marker::PhantomData<T>);
    impl<'de, T: Deserialize<'de>> Visitor<'de> for MapOnly<T> {
        type Value = Option<T>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("an optional metadata object")
        }
        fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Self::Value, A::Error> {
            T::deserialize(MapAccessDeserializer::new(map)).map(Some)
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            while seq.next_element::<IgnoredAny>()?.is_some() {}
            Ok(None)
        }
        fn visit_str<E: serde::de::Error>(self, _: &str) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_bool<E: serde::de::Error>(self, _: bool) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_i64<E: serde::de::Error>(self, _: i64) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_u64<E: serde::de::Error>(self, _: u64) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_f64<E: serde::de::Error>(self, _: f64) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
            Ok(None)
        }
    }
    deserializer.deserialize_any(MapOnly(std::marker::PhantomData))
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Origin {
    Name(String),
    Object {
        subagent: Option<serde::de::IgnoredAny>,
    },
}

#[derive(Deserialize)]
struct ProjectPaths {
    cwd: Option<String>,
    root: Option<String>,
}

fn optional_id<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Id {
        Text(String),
        Number(serde_json::Number),
    }
    Ok(match Option::<Id>::deserialize(deserializer)? {
        Some(Id::Text(id)) => Some(id),
        // Numeric message row IDs are not session identifiers.
        Some(Id::Number(number)) => {
            let _ = number;
            None
        }
        None => None,
    })
}

pub(crate) fn project_path(raw: &str) -> Option<PathBuf> {
    let path = Path::new(raw);
    if !path.is_absolute() {
        return None;
    }
    if let Ok(path) = path.canonicalize() {
        return Some(path);
    }
    // Never accept a lexical /allowed/../other prefix when canonicalize fails.
    if path.components().any(|c| c == Component::ParentDir) {
        return None;
    }
    Some(path.components().collect())
}

pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id != "."
        && id != ".."
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}

impl Metadata {
    fn children(&self) -> impl Iterator<Item = &Metadata> {
        [&self.payload, &self.info, &self.message, &self.custom]
            .into_iter()
            .filter_map(|v| v.as_deref())
    }

    pub(crate) fn directories(&self) -> Vec<&str> {
        let mut dirs: Vec<_> = [
            &self.cwd,
            &self.directory,
            &self.work_dir,
            &self.relocated_cwd,
        ]
        .into_iter()
        .filter_map(|v| v.as_deref())
        .collect();
        if let Some(path) = &self.path {
            dirs.extend(
                [path.cwd.as_deref(), path.root.as_deref()]
                    .into_iter()
                    .flatten(),
            );
        }
        for child in self.children() {
            dirs.extend(child.directories());
        }
        dirs
    }

    pub(crate) fn check(
        &self,
        provider: &str,
        expected_id: Option<&str>,
    ) -> Result<(), MetadataError> {
        let session_parents = [
            &self.parent_session_id,
            &self.parent_session_id_camel,
            &self.parent_session,
            &self.parent_thread_id,
            &self.agent_id_camel,
            &self.agent_id,
        ];
        let is_header = matches!(
            self.kind.as_deref(),
            Some("session" | "init" | "session_meta")
        ) || (provider == "opencode"
            && self.session_id_upper.is_none()
            && self.message_id.is_none());
        // Pi parentId and OpenCode message parentID are message-tree edges.
        let has_parent = is_header
            && [
                &self.parent_id_upper,
                &self.parent_id_camel,
                &self.parent_id,
            ]
            .into_iter()
            .any(|v| v.as_ref().is_some_and(|v| !v.is_empty()));
        if has_parent
            || session_parents
                .into_iter()
                .any(|v| v.as_ref().is_some_and(|v| !v.is_empty()))
            || self.is_sidechain_camel == Some(true)
            || self.is_sidechain == Some(true)
            || self.is_subagent_camel == Some(true)
            || self.is_subagent == Some(true)
            || self
                .session_kind
                .as_deref()
                .is_some_and(|v| v.contains("subagent"))
        {
            return Err(MetadataError::Excluded);
        }
        if provider == "codex" {
            match &self.source {
                Some(Origin::Name(name)) if name.contains("subagent") => {
                    return Err(MetadataError::Excluded)
                }
                Some(Origin::Object { subagent: Some(_) }) => return Err(MetadataError::Excluded),
                Some(Origin::Object { subagent: None }) => {
                    return Err(MetadataError::Invalid("ambiguous Codex source metadata"))
                }
                _ => {}
            }
        }
        let mut found = expected_id;
        for id in self.session_ids(provider) {
            if !valid_id(id) || found.is_some_and(|expected| expected != id) {
                return Err(MetadataError::Invalid("session identity mismatch"));
            }
            found = Some(id);
        }
        if let Some(expected) = expected_id.filter(|_| provider != "claude") {
            let header_id = match self.kind.as_deref() {
                Some("session" | "init") => self.id.as_deref(),
                Some("session_meta") => self.payload.as_deref().and_then(|p| p.id.as_deref()),
                _ => None,
            };
            if header_id.is_some_and(|id| id != expected) {
                return Err(MetadataError::Invalid("session identity mismatch"));
            }
        }
        for dir in self.directories() {
            if project_path(dir).is_none() {
                return Err(MetadataError::Invalid(
                    "project metadata must be an unambiguous absolute path",
                ));
            }
        }
        for child in self.children() {
            child.check(provider, expected_id)?;
        }
        Ok(())
    }

    fn session_ids(&self, provider: &str) -> impl Iterator<Item = &str> {
        // Claude snake IDs belong to the SDK/backend, not the CLI transcript.
        [
            self.session_id_camel.as_deref(),
            if provider == "claude" {
                None
            } else {
                self.session_id_upper.as_deref()
            },
            if provider == "claude" {
                None
            } else {
                self.session_id.as_deref()
            },
        ]
        .into_iter()
        .flatten()
    }

    pub(crate) fn explicit_session_id(
        &self,
        provider: &str,
    ) -> Result<Option<&str>, MetadataError> {
        let mut found = None;
        for id in self.session_ids(provider) {
            if !valid_id(id) || found.is_some_and(|expected| expected != id) {
                return Err(MetadataError::Invalid("session identity mismatch"));
            }
            found = Some(id);
        }
        Ok(found)
    }

    fn check_session(&self, provider: &str, id: &str) -> Result<(), MetadataError> {
        // An untagged OpenCode session or a Codex payload is still a session
        // header, even if a sessionID alias is also present.
        if [
            &self.parent_id_upper,
            &self.parent_id_camel,
            &self.parent_id,
        ]
        .into_iter()
        .any(|v| v.as_ref().is_some_and(|v| !v.is_empty()))
        {
            return Err(MetadataError::Excluded);
        }
        self.check(provider, Some(id))
    }
}

pub(crate) fn read_json(path: &Path) -> Result<Metadata, MetadataError> {
    let file = File::open(path).map_err(|_| MetadataError::Invalid("cannot open metadata file"))?;
    if file
        .metadata()
        .map_err(|_| MetadataError::Invalid("cannot inspect metadata file"))?
        .len()
        > MAX_METADATA_BYTES as u64
    {
        return Err(MetadataError::Invalid("metadata file exceeds size limit"));
    }
    let mut bytes = Vec::new();
    file.take(MAX_METADATA_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| MetadataError::Invalid("cannot read metadata object"))?;
    if bytes.len() > MAX_METADATA_BYTES || bytes.trim_ascii().first() != Some(&b'{') {
        return Err(MetadataError::Invalid(
            "metadata must be a bounded JSON object",
        ));
    }
    serde_json::from_slice(&bytes).map_err(|_| MetadataError::Invalid("invalid metadata object"))
}

pub(crate) fn open_lines(provider: &str, path: &Path) -> Result<Box<dyn BufRead>, MetadataError> {
    if provider == "codex" {
        return crate::codex_rollout_file::open_reader(path)
            .map(|r| r as Box<dyn BufRead>)
            .map_err(|_| MetadataError::Invalid("cannot open Codex metadata stream"));
    }
    File::open(path)
        .map(|f| Box::new(BufReader::new(f)) as Box<dyn BufRead>)
        .map_err(|_| MetadataError::Invalid("cannot open metadata stream"))
}

pub(crate) fn next_record(reader: &mut dyn BufRead) -> Result<Option<Metadata>, MetadataError> {
    let mut line = Vec::new();
    loop {
        line.clear();
        let count = reader
            .take(MAX_METADATA_BYTES as u64 + 1)
            .read_until(b'\n', &mut line)
            .map_err(|_| MetadataError::Invalid("cannot read metadata record"))?;
        if count == 0 {
            return Ok(None);
        }
        if line.len() > MAX_METADATA_BYTES {
            return Err(MetadataError::Invalid("metadata record exceeds size limit"));
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        return parse_record(&line);
    }
}

pub(crate) fn parse_record(line: &[u8]) -> Result<Option<Metadata>, MetadataError> {
    if line.trim_ascii().first() != Some(&b'{') {
        return Err(MetadataError::Invalid(
            "metadata record must be a JSON object",
        ));
    }
    match serde_json::from_slice(line) {
        Ok(record) => Ok(Some(record)),
        // A writer can leave an incomplete final record. A terminated bad line,
        // semantic metadata error, or syntactically invalid tail still fails.
        Err(error) if !line.ends_with(b"\n") && error.is_eof() => Ok(None),
        Err(_) => Err(MetadataError::Invalid("invalid session metadata record")),
    }
}

pub(crate) fn locate_file(provider: &str, path: &Path) -> Result<Location, MetadataError> {
    let header = if provider == "opencode" {
        read_json(path)?
    } else {
        let mut reader = open_lines(provider, path)?;
        let mut record =
            next_record(&mut *reader)?.ok_or(MetadataError::Invalid("session header missing"))?;
        if provider == "omp" && record.kind.as_deref() == Some("title") {
            record = next_record(&mut *reader)?
                .ok_or(MetadataError::Invalid("session header missing"))?;
        }
        // Claude can prepend metadata records, but never infer a header from message content.
        if provider == "claude" {
            for _ in 0..19 {
                record.check(provider, None)?;
                if record.explicit_session_id(provider)?.is_some()
                    && !record.directories().is_empty()
                {
                    break;
                }
                if matches!(
                    record.kind.as_deref(),
                    Some("user" | "assistant" | "message")
                ) {
                    return Err(MetadataError::Invalid(
                        "Claude message has no session location metadata",
                    ));
                }
                record = next_record(&mut *reader)?
                    .ok_or(MetadataError::Invalid("session header missing"))?;
            }
        }
        record
    };
    header.check(provider, None)?;
    let record = match provider {
        "codex" if header.kind.as_deref() == Some("session_meta") => header
            .payload
            .as_deref()
            .ok_or(MetadataError::Invalid("Codex session metadata missing"))?,
        "claude" | "opencode" => &header,
        "pi" | "omp" if header.kind.as_deref() == Some("session") => &header,
        "hermes" if matches!(header.kind.as_deref(), Some("session" | "init")) => &header,
        _ => {
            return Err(MetadataError::Invalid(
                "session header missing or unsupported",
            ))
        }
    };
    let explicit = record.explicit_session_id(provider)?;
    let id = if provider == "claude" {
        explicit
    } else {
        if record
            .id
            .as_deref()
            .zip(explicit)
            .is_some_and(|(a, b)| a != b)
        {
            return Err(MetadataError::Invalid("session identity mismatch"));
        }
        record.id.as_deref().or(explicit)
    }
    .filter(|id| valid_id(id))
    .ok_or(MetadataError::Invalid("session ID missing or invalid"))?;
    record.check_session(provider, id)?;
    let cwd = record
        .cwd
        .as_deref()
        .or(record.directory.as_deref())
        .ok_or(MetadataError::Invalid("session project metadata missing"))?;
    let actual = project_path(cwd).ok_or(MetadataError::Invalid("invalid project metadata"))?;
    if header
        .directories()
        .iter()
        .any(|dir| project_path(dir).as_ref() != Some(&actual))
    {
        return Err(MetadataError::Invalid(
            "conflicting session project metadata",
        ));
    }
    if provider == "opencode" && path.file_stem().and_then(|v| v.to_str()) != Some(id) {
        return Err(MetadataError::Invalid(
            "OpenCode metadata filename identity mismatch",
        ));
    }
    Ok(Location {
        session_id: id.to_string(),
        cwd: cwd.to_string(),
    })
}

pub fn locate_batch(requests: &[LocateRequest]) -> Vec<LocateResult> {
    requests
        .iter()
        .map(|request| {
            let mut row = LocateResult {
                provider: request.provider.clone(),
                source: request.source.clone(),
                status: "unsupported",
                session_id: None,
                cwd: None,
                error: None,
            };
            if !["codex", "claude", "pi", "omp", "hermes", "opencode"]
                .contains(&request.provider.as_str())
            {
                return row;
            }
            match locate_file(&request.provider, Path::new(&request.source)) {
                Ok(location) => {
                    row.status = "located";
                    row.session_id = Some(location.session_id);
                    row.cwd = Some(location.cwd);
                }
                Err(error) => {
                    row.status = if matches!(error, MetadataError::Excluded) {
                        "excluded"
                    } else {
                        "metadata_error"
                    };
                    row.error = Some(error.message());
                }
            }
            row
        })
        .collect()
}
