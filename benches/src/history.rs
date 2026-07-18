// Cross-run persistence for fitted complexity results, so a regression that
// creeps in gradually across many small commits is visible even though no
// single run trips the existing fixed 10%-over-baseline gate.
//
// One JSONL file per operation under `benches/history/`, committed to the
// repo by CI on pushes to `main` (see `.github/workflows/benchmarks.yml`) —
// append-only, one line per CI run, so history is diffable in normal `git
// log` rather than living only in GitHub Actions artifact retention.

use crate::scaling::history_dir;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub commit: String,
    pub timestamp: String,
    pub n_max: u32,
    pub exponent: f64,
    pub r_squared: f64,
    pub cpu_at_n_max: u64,
    pub mem_at_n_max: u64,
}

pub fn history_path(op: &str) -> PathBuf {
    history_dir().join(format!("{op}.jsonl"))
}

/// Loads all prior recorded entries for `op`, oldest first. Returns an empty
/// vec if no history file exists yet (first run for this operation).
pub fn load_history(op: &str) -> Vec<HistoryEntry> {
    let path = history_path(op);
    let Ok(contents) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    contents
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

pub fn append_entry(op: &str, entry: &HistoryEntry) -> std::io::Result<()> {
    let path = history_path(op);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let line = serde_json::to_string(entry).expect("failed to serialize HistoryEntry");
    let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
    writeln!(file, "{line}")
}

#[derive(Debug, Clone, Copy)]
pub struct DriftWarning {
    pub baseline_exponent: f64,
    pub current_exponent: f64,
    pub delta: f64,
}

/// Flags drift beyond this many exponent-units above the trailing baseline.
/// Deliberately looser than the per-run classification buckets in
/// `complexity.rs`: this is meant to catch *creep* relative to this
/// operation's own recent history, not to duplicate the absolute
/// quadratic-or-worse gate.
const DRIFT_THRESHOLD: f64 = 0.3;

/// Compares the current run's fitted exponent against a smoothed baseline
/// (mean of up to the last 5 history entries) so a single noisy prior run
/// doesn't dominate the comparison. Returns `None` when there's no history
/// yet or the exponent hasn't drifted meaningfully.
pub fn detect_drift(history: &[HistoryEntry], current_exponent: f64) -> Option<DriftWarning> {
    if history.is_empty() {
        return None;
    }
    let window: Vec<f64> = history.iter().rev().take(5).map(|e| e.exponent).collect();
    let baseline = window.iter().sum::<f64>() / window.len() as f64;
    let delta = current_exponent - baseline;
    if delta > DRIFT_THRESHOLD {
        Some(DriftWarning { baseline_exponent: baseline, current_exponent, delta })
    } else {
        None
    }
}
