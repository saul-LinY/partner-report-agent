use std::path::PathBuf;

pub fn get_home_dir() -> PathBuf {
    dirs::home_dir().expect("home directory unavailable")
}

/// Explicit reader directories are portable configuration, not CC Switch settings.
/// A menu-bar host should set these itself instead of assuming shell environment.
pub fn agent_dir(provider: &str) -> PathBuf {
    let override_key = if provider == "pi" {
        "SESSION_READER_PI_AGENT_DIR"
    } else {
        "SESSION_READER_OMP_AGENT_DIR"
    };
    if let Some(dir) = std::env::var_os(override_key).filter(|s| !s.is_empty()) {
        return PathBuf::from(dir);
    }
    if provider == "pi" {
        return std::env::var_os("PI_CODING_AGENT_DIR")
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| get_home_dir().join(".pi/agent"));
    }
    let config = std::env::var_os("PI_CONFIG_DIR")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .map(|p| {
            if p.is_absolute() {
                p
            } else {
                get_home_dir().join(p)
            }
        })
        .unwrap_or_else(|| get_home_dir().join(".omp"));
    let profile = std::env::var("OMP_PROFILE")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("PI_PROFILE").ok().filter(|s| !s.is_empty()))
        .filter(|s| s != "default");
    if let Some(profile) = profile {
        return config.join("profiles").join(profile).join("agent");
    }
    let agent = std::env::var_os("PI_CODING_AGENT_DIR")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| config.join("agent"));
    let xdg = std::env::var_os("XDG_DATA_HOME")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .map(|p| p.join("omp"));
    if agent == get_home_dir().join(".omp/agent") {
        if let Some(xdg) = xdg.filter(|p| p.is_dir()) {
            return xdg;
        }
    }
    agent
}
