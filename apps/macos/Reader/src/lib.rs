//! Read-only session parsing extracted from CC Switch.
//! Callers must authorize source metadata before invoking transcript parsing.
pub mod codex_rollout_file;
pub mod config;
pub mod extraction;
pub mod locate;
pub mod session_manager;

pub use extraction::{extract_manifest, Job, Manifest};

pub(crate) mod pi_config {
    use std::path::PathBuf;
    pub struct Defaults {
        pub session_dir: Option<String>,
    }
    pub fn get_pi_agent_dir() -> Result<PathBuf, String> {
        Ok(crate::config::agent_dir("pi"))
    }
    pub fn read_pi_native_defaults() -> Result<Defaults, String> {
        let path = crate::config::agent_dir("pi").join("settings.json");
        if !path.exists() {
            return Ok(Defaults { session_dir: None });
        }
        let value: serde_json::Value =
            json5::from_str(&std::fs::read_to_string(path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if !value.is_object() {
            return Err("Pi settings must be an object".into());
        }
        let session_dir = match value.get("sessionDir") {
            None | Some(serde_json::Value::Null) => None,
            Some(serde_json::Value::String(path)) => Some(path.clone()),
            _ => return Err("Pi sessionDir must be a string".into()),
        };
        Ok(Defaults { session_dir })
    }
}
pub(crate) mod omp_config {
    use std::path::PathBuf;
    pub fn get_omp_data_dir() -> Result<PathBuf, String> {
        Ok(crate::config::agent_dir("omp"))
    }
}
