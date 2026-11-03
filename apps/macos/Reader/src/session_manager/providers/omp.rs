// Derived from CC Switch 4.0.21 (6d6b716); MIT, Copyright (c) 2025 Jason Young.
// Session reading only. See UPSTREAM.json and LICENSE.
#![allow(dead_code, unused_imports)]
use super::pi::{self, Dialect, SessionLayout, SessionRootResolution};
use crate::session_manager::SessionMessage;
use std::fs;
use std::path::{Path, PathBuf};
const OMP: Dialect = Dialect {
    provider_id: "omp",
    label: "Oh My Pi",
    resolve_root: resolve_session_root,
    title_slot: true,
    model_selector: true,
};
/// omp 与 Pi 共用 `PI_CODING_AGENT_SESSION_DIR`（上游行为）；未设置时按 profile 放在数据目录下。
fn resolve_session_root() -> SessionRootResolution {
    if let Some(raw) = std::env::var_os("PI_CODING_AGENT_SESSION_DIR").filter(|raw| !raw.is_empty())
    {
        let root = PathBuf::from(&raw);
        return if root.is_absolute() {
            SessionRootResolution::Available {
                root,
                layout: SessionLayout::Flat,
            }
        } else {
            SessionRootResolution::RequiresProjectContext {
                configured_path: raw.to_string_lossy().into_owned(),
            }
        };
    }
    match crate::omp_config::get_omp_data_dir() {
        Ok(dir) => SessionRootResolution::Available {
            root: dir.join("sessions"),
            layout: SessionLayout::ProjectDirectories,
        },
        Err(error) => SessionRootResolution::Unavailable {
            reason: error.to_string(),
        },
    }
}
pub fn load_messages(path: &Path) -> Result<Vec<SessionMessage>, String> {
    pi::load_messages_for(&OMP, path)
}
