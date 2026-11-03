#![allow(dead_code)]
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
pub struct Fixture {
    pub root: PathBuf,
    pub project: PathBuf,
}
impl Fixture {
    pub fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "reader-regression-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        Self {
            root: root.canonicalize().unwrap(),
            project: project.canonicalize().unwrap(),
        }
    }
    pub fn write(&self, name: &str, bytes: impl AsRef<[u8]>) -> PathBuf {
        let path = self.root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        path
    }
    pub fn lines(&self, name: &str, rows: &[Value]) -> PathBuf {
        self.write(
            name,
            rows.iter()
                .map(|r| r.to_string() + "\n")
                .collect::<String>(),
        )
    }
    pub fn locate(&self, requests: Value) -> (Vec<Value>, Output) {
        let input = self.write("locate-input.json", requests.to_string());
        let output = self.root.join("locate-output.json");
        let process = Command::new(env!("CARGO_BIN_EXE_cc-session-reader"))
            .args([
                "--locate",
                input.to_str().unwrap(),
                output.to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(process.status.success(), "locate command failed");
        let rows = serde_json::from_slice(&fs::read(output).unwrap()).unwrap();
        (rows, process)
    }
    pub fn extract(&self, provider: &str, source: &Path, id: &str) -> Value {
        let input = self.write("manifest.json", json!({"authorized_root":self.project,"jobs":[{
            "provider":provider,"source":source,"session_id":id,"project":self.project,"allowed":true
        }]}).to_string());
        let output = self.root.join("results.json");
        let process = Command::new(env!("CARGO_BIN_EXE_cc-session-reader"))
            .args([&input, &output])
            .env("PI_CODING_AGENT_SESSION_DIR", source.parent().unwrap())
            .output()
            .unwrap();
        assert!(process.status.success(), "extract command failed");
        let mut rows: Vec<Value> = serde_json::from_slice(&fs::read(output).unwrap()).unwrap();
        rows.remove(0)
    }
    pub fn discover_then_extract(&self, provider: &str, source: &Path) -> Value {
        let (rows, _) = self.locate(json!([{"provider":provider,"source":source}]));
        assert_eq!(rows[0]["status"], "located");
        assert_eq!(rows[0]["cwd"], self.project.to_str().unwrap());
        self.extract(provider, source, rows[0]["session_id"].as_str().unwrap())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
