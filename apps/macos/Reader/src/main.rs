fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() == 4 && args[1] == "--locate" {
        let requests: Vec<cc_session_reader::locate::LocateRequest> =
            serde_json::from_slice(&std::fs::read(&args[2])?)
                .map_err(|_| "invalid locate request JSON")?;
        let rows = cc_session_reader::locate::locate_batch(&requests);
        write_results(&args[3], &serde_json::to_vec_pretty(&rows)?)?;
        return Ok(());
    }
    if args.len() != 3 {
        return Err("usage: cc-session-reader [--locate] input.json output.json".into());
    }
    let manifest: cc_session_reader::Manifest =
        serde_json::from_slice(&std::fs::read(&args[1])?).map_err(|_| "invalid manifest JSON")?;
    let rows = cc_session_reader::extract_manifest(&manifest)?;
    let bytes = serde_json::to_vec_pretty(&rows)?;
    write_results(&args[2], &bytes)?;
    for provider in [
        "codex",
        "claude",
        "omp",
        "pi",
        "opencode",
        "hermes",
        "grokbuild",
        "agy",
    ] {
        let selected: Vec<_> = rows.iter().filter(|r| r["provider"] == provider).collect();
        if selected.is_empty() {
            continue;
        }
        println!(
            "{}: sources={}, parsed={}, turns={}",
            provider,
            selected.len(),
            selected.iter().filter(|r| r["status"] == "parsed").count(),
            selected
                .iter()
                .filter_map(|r| r["turns"].as_array())
                .flatten()
                .count()
        );
    }
    Ok(())
}

fn write_results(path: &str, bytes: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        options.mode(0o600);
        if let Ok(meta) = std::fs::symlink_metadata(path) {
            if meta.file_type().is_symlink() {
                return Err("output must not be a symlink".into());
            }
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
    }
    use std::io::Write;
    options.open(path)?.write_all(bytes)?;
    Ok(())
}
