// Reads the raw scaling data points written by the scaling benchmarks in
// `tests/benchmarks.rs`, fits a complexity curve per operation, updates
// cross-run history, renders a Markdown report, and exits non-zero if any
// operation classifies as quadratic-or-worse. This is the additive gate on
// top of (not a replacement for) the fixed-size threshold `assert!`s already
// in `tests/benchmarks.rs`.
//
// Usage: cargo run --manifest-path benches/Cargo.toml --bin scaling_report
// (run `cargo test --manifest-path benches/Cargo.toml --test benchmarks --
// --nocapture` first to populate the raw data points.)

use quorum_proof_benches::{complexity, history, report, scaling};
use std::collections::BTreeMap;
use std::process::Command;

fn current_timestamp() -> String {
    Command::new("date")
        .args(["-u", "+%Y-%m-%dT%H:%M:%SZ"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn current_commit() -> String {
    if let Ok(sha) = std::env::var("GITHUB_SHA") {
        if !sha.is_empty() {
            return sha;
        }
    }
    Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn main() {
    let points = scaling::load_points();
    if points.is_empty() {
        eprintln!(
            "No scaling data points found at {}. Run the scaling benchmarks first:\n  \
             cargo test --manifest-path benches/Cargo.toml --test benchmarks -- --nocapture",
            scaling::raw_points_path().display()
        );
        std::process::exit(2);
    }

    let mut by_op: BTreeMap<String, Vec<(u32, u64, u64)>> = BTreeMap::new();
    for p in points {
        by_op.entry(p.op.clone()).or_default().push((p.n, p.cpu, p.mem));
    }

    let commit = current_commit();
    let generated_at = current_timestamp();

    let mut reports = Vec::new();

    for (op, mut pts) in by_op {
        pts.sort_by_key(|(n, _, _)| *n);

        let cpu_points: Vec<(u32, u64)> = pts.iter().map(|(n, cpu, _)| (*n, *cpu)).collect();
        let mem_points: Vec<(u32, u64)> = pts.iter().map(|(n, _, mem)| (*n, *mem)).collect();

        let cpu_fit = complexity::fit_power_law(&cpu_points);
        let mem_fit = complexity::fit_power_law(&mem_points);

        // Drift is computed against history *before* this run's entry is
        // appended, so it never compares a run against itself.
        let hist = history::load_history(&op);
        let drift = cpu_fit.and_then(|f| history::detect_drift(&hist, f.exponent));

        if let (Some((n_max, cpu_at_max, mem_at_max)), Some(cf)) =
            (pts.last().map(|(n, c, m)| (*n, *c, *m)), cpu_fit)
        {
            let entry = history::HistoryEntry {
                commit: commit.clone(),
                timestamp: generated_at.clone(),
                n_max,
                exponent: cf.exponent,
                r_squared: cf.r_squared,
                cpu_at_n_max: cpu_at_max,
                mem_at_n_max: mem_at_max,
            };
            if let Err(e) = history::append_entry(&op, &entry) {
                eprintln!("warning: failed to append history for {op}: {e}");
            }
        }

        reports.push(report::OpReport { op, points: pts, cpu_fit, mem_fit, drift });
    }

    let markdown = report::render_report(&generated_at, &commit, &reports);
    let report_path = scaling::report_path();
    if let Some(parent) = report_path.parent() {
        std::fs::create_dir_all(parent).expect("failed to create report dir");
    }
    std::fs::write(&report_path, &markdown).expect("failed to write report");

    println!("{markdown}");
    println!("Report written to {}", report_path.display());

    let any_failing = reports.iter().any(|r| r.is_failing());
    if any_failing {
        eprintln!("❌ One or more operations classified as quadratic-or-worse.");
        std::process::exit(1);
    }
}
