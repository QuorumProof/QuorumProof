// Renders the human-readable Markdown report attached to CI runs, summarizing
// the fitted complexity class per operation plus any drift versus history.

use crate::complexity::FitResult;
use crate::history::DriftWarning;

pub struct OpReport {
    pub op: String,
    /// (n, cpu, mem) points, sorted ascending by n.
    pub points: Vec<(u32, u64, u64)>,
    pub cpu_fit: Option<FitResult>,
    pub mem_fit: Option<FitResult>,
    pub drift: Option<DriftWarning>,
}

impl OpReport {
    pub fn is_failing(&self) -> bool {
        self.cpu_fit.map(|f| classify_failing(f)).unwrap_or(false)
            || self.mem_fit.map(|f| classify_failing(f)).unwrap_or(false)
    }
}

fn classify_failing(fit: FitResult) -> bool {
    crate::complexity::classify(fit.exponent).is_failing()
}

fn fmt_fit(fit: Option<FitResult>) -> String {
    match fit {
        Some(f) => {
            let class = crate::complexity::classify(f.exponent);
            format!("b={:.2}, R²={:.2} ({})", f.exponent, f.r_squared, class.label())
        }
        None => "n/a (not enough data points)".to_string(),
    }
}

pub fn render_report(generated_at: &str, commit: &str, reports: &[OpReport]) -> String {
    let mut out = String::new();
    out.push_str("# Benchmark Scaling Report\n\n");
    out.push_str(&format!("_Generated: {generated_at} · commit `{commit}`_\n\n"));

    let any_failing = reports.iter().any(|r| r.is_failing());
    let any_drift = reports.iter().any(|r| r.drift.is_some());
    let overall = if any_failing {
        "❌ FAIL — quadratic-or-worse growth detected"
    } else if any_drift {
        "⚠️ PASS with drift warnings — see below"
    } else {
        "✅ PASS"
    };
    out.push_str(&format!("**Overall: {overall}**\n\n"));

    out.push_str("This report is additive to the existing fixed-size threshold gate in \
        `benches/tests/benchmarks.rs` — it does not replace it.\n\n");

    for r in reports {
        out.push_str(&format!("## `{}`\n\n", r.op));
        out.push_str("| n | CPU (instructions) | Memory (bytes) |\n|---|---|---|\n");
        for (n, cpu, mem) in &r.points {
            out.push_str(&format!("| {n} | {cpu} | {mem} |\n"));
        }
        out.push('\n');
        out.push_str(&format!("- CPU fit: {}\n", fmt_fit(r.cpu_fit)));
        out.push_str(&format!("- Memory fit: {}\n", fmt_fit(r.mem_fit)));
        if let Some(DriftWarning { baseline_exponent, current_exponent, delta }) = r.drift {
            out.push_str(&format!(
                "- ⚠️ Drift vs. recent history: exponent {baseline_exponent:.2} → {current_exponent:.2} (+{delta:.2}). \
                 No single run crossed the fixed threshold, but this operation's growth rate has been creeping up.\n"
            ));
        }
        if r.is_failing() {
            out.push_str("- ❌ **Classified quadratic-or-worse — additive gate failure.**\n");
        }
        out.push('\n');
    }

    out
}
