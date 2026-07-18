// Benchmark suite — see tests/ for the actual benchmark tests.
//
// This lib also hosts the scaling-benchmark analysis used by
// `src/bin/scaling_report.rs`: raw data collection (`scaling`), power-law
// curve fitting and complexity classification (`complexity`), cross-run
// history persistence (`history`), and Markdown report rendering (`report`).

pub mod complexity;
pub mod history;
pub mod report;
pub mod scaling;
