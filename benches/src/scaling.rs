// Raw (n, cost) data points collected by the scaling benchmarks in
// `tests/benchmarks.rs`, persisted to `target/bench-scaling/raw.jsonl` for
// `bin/scaling_report.rs` to fit a complexity curve against.
//
// Paths are anchored on `CARGO_MANIFEST_DIR` (this crate's directory) rather
// than the process CWD or the workspace target dir: `benches/` is not a
// member of the root Cargo workspace, so its effective workspace root
// (and therefore its `target/` location) depends on how it's invoked.
// `CARGO_MANIFEST_DIR` is stable regardless of invocation style and is
// shared at compile time by both the integration test binary and this lib.

use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScalingPoint {
    pub op: String,
    pub n: u32,
    pub cpu: u64,
    pub mem: u64,
}

fn manifest_dir() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

pub fn raw_points_path() -> PathBuf {
    manifest_dir().join("target/bench-scaling/raw.jsonl")
}

pub fn report_path() -> PathBuf {
    manifest_dir().join("target/bench-scaling-report.md")
}

pub fn history_dir() -> PathBuf {
    manifest_dir().join("history")
}

/// Appends one data point to `raw.jsonl`. Call `reset_raw_points` once at the
/// start of a scaling run to avoid mixing points from a previous run.
pub fn record_point(op: &str, n: u32, cpu: u64, mem: u64) {
    let path = raw_points_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("failed to create bench-scaling dir");
    }
    let point = ScalingPoint { op: op.to_string(), n, cpu, mem };
    let line = serde_json::to_string(&point).expect("failed to serialize ScalingPoint");
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .unwrap_or_else(|e| panic!("failed to open {}: {e}", path.display()));
    writeln!(file, "{line}").expect("failed to write scaling point");
}

/// Truncates `raw.jsonl` so a fresh test run doesn't append to stale data.
pub fn reset_raw_points() {
    let path = raw_points_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("failed to create bench-scaling dir");
    }
    fs::write(&path, "").expect("failed to reset raw.jsonl");
}

/// Reads all recorded points, grouped by operation name.
pub fn load_points() -> Vec<ScalingPoint> {
    let path = raw_points_path();
    let Ok(contents) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    contents
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("bad scaling point line: {e}")))
        .collect()
}
