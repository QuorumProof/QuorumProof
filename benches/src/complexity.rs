// Empirical complexity-class fitting for scaling benchmark data.
//
// Given (n, cost) points from running an operation at several input sizes,
// fits `cost ≈ a·n^b` by ordinary least squares on (ln n, ln cost) — a
// standard log-log linearization of a power law. `b` (the `exponent`) is the
// thing we care about: b≈1 is linear, b≈2 is quadratic, etc.
//
// Bucket thresholds are heuristic, not exact Big-O classification: with only
// a handful of (small, capped) n values, O(n) and O(n·log n) fits produce
// very similar slopes and can't be reliably told apart. The buckets below
// are deliberately coarse so the gate only fires on genuinely worse-than-
// expected growth rather than false-positiving on log factors.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FitResult {
    pub exponent: f64,
    pub r_squared: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ComplexityClass {
    /// exponent < 1.2 — linear or better.
    LinearOrBetter,
    /// 1.2 <= exponent < 1.8 — superlinear; possibly n·log n, or a mild
    /// polynomial. Worth a human look but not gate-failing on its own.
    Superlinear,
    /// exponent >= 1.8 — quadratic or worse. Fails the additive gate.
    QuadraticOrWorse,
}

impl ComplexityClass {
    pub fn is_failing(self) -> bool {
        matches!(self, ComplexityClass::QuadraticOrWorse)
    }

    pub fn label(self) -> &'static str {
        match self {
            ComplexityClass::LinearOrBetter => "linear-or-better",
            ComplexityClass::Superlinear => "superlinear (possible n log n)",
            ComplexityClass::QuadraticOrWorse => "quadratic-or-worse",
        }
    }
}

pub fn classify(exponent: f64) -> ComplexityClass {
    if exponent < 1.2 {
        ComplexityClass::LinearOrBetter
    } else if exponent < 1.8 {
        ComplexityClass::Superlinear
    } else {
        ComplexityClass::QuadraticOrWorse
    }
}

/// Fits `cost ≈ a·n^b` to the given (n, cost) points via least-squares
/// regression on (ln n, ln cost). Returns `None` if fewer than two distinct,
/// strictly-positive-n points are available (a power-law fit is meaningless
/// otherwise).
pub fn fit_power_law(points: &[(u32, u64)]) -> Option<FitResult> {
    let xs_ys: Vec<(f64, f64)> = points
        .iter()
        .filter(|(n, cost)| *n > 0 && *cost > 0)
        .map(|(n, cost)| ((*n as f64).ln(), (*cost as f64).ln()))
        .collect();

    if xs_ys.len() < 2 {
        return None;
    }

    let count = xs_ys.len() as f64;
    let sum_x: f64 = xs_ys.iter().map(|(x, _)| x).sum();
    let sum_y: f64 = xs_ys.iter().map(|(_, y)| y).sum();
    let mean_x = sum_x / count;
    let mean_y = sum_y / count;

    let mut ss_xx = 0.0;
    let mut ss_xy = 0.0;
    for (x, y) in &xs_ys {
        ss_xx += (x - mean_x) * (x - mean_x);
        ss_xy += (x - mean_x) * (y - mean_y);
    }

    if ss_xx == 0.0 {
        // All points share the same n — no variation to fit a slope against.
        return None;
    }

    let slope = ss_xy / ss_xx;
    let intercept = mean_y - slope * mean_x;

    let ss_tot: f64 = xs_ys.iter().map(|(_, y)| (y - mean_y).powi(2)).sum();
    let ss_res: f64 = xs_ys
        .iter()
        .map(|(x, y)| {
            let predicted = intercept + slope * x;
            (y - predicted).powi(2)
        })
        .sum();
    let r_squared = if ss_tot == 0.0 { 1.0 } else { 1.0 - (ss_res / ss_tot) };

    Some(FitResult { exponent: slope, r_squared })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic, seeded LCG — same construction as
    /// `generate_batch_metadata` in `load_test_batch_operations.rs`. No
    /// wall-clock or OS randomness, so this test is fully reproducible.
    struct Lcg(u32);
    impl Lcg {
        fn next_unit(&mut self) -> f64 {
            self.0 = self.0.wrapping_mul(1103515245).wrapping_add(12345);
            // Top 24 bits, normalized to [0, 1) then shifted to [-0.5, 0.5).
            ((self.0 >> 8) as f64 / 16_777_216.0) - 0.5
        }
    }

    /// Seeded negative test: a synthetic operation with deliberately
    /// quadratic cost (`cost = a·n² + noise`) must be classified as
    /// quadratic-or-worse. This exercises the fitting/classification code
    /// itself, independent of what any real contract currently does.
    #[test]
    fn detects_seeded_quadratic_growth() {
        let mut rng = Lcg(0xC0FF_EE42); // fixed seed
        let a = 1_000.0;
        let points: Vec<(u32, u64)> = [1u32, 5, 10, 25, 50, 100]
            .iter()
            .map(|&n| {
                let noise = rng.next_unit() * a; // small deterministic wobble
                let cost = (a * (n as f64).powi(2) + noise).max(1.0);
                (n, cost as u64)
            })
            .collect();

        let fit = fit_power_law(&points).expect("expected a fit for 6 distinct n values");
        assert!(
            fit.exponent >= 1.8,
            "seeded quadratic series should fit with exponent >= 1.8, got {}",
            fit.exponent
        );
        assert_eq!(
            classify(fit.exponent),
            ComplexityClass::QuadraticOrWorse,
            "seeded quadratic series must be classified as quadratic-or-worse (exponent={}, r2={})",
            fit.exponent,
            fit.r_squared
        );
        assert!(fit.r_squared > 0.9, "fit should be tight for a clean power-law series, r2={}", fit.r_squared);
    }

    /// Sanity check in the other direction: a linear series must NOT be
    /// misclassified as failing, so the negative test above is meaningful
    /// rather than the classifier always tripping.
    #[test]
    fn does_not_flag_linear_growth() {
        let mut rng = Lcg(7);
        let a = 500.0;
        let points: Vec<(u32, u64)> = [1u32, 5, 10, 25, 50, 100]
            .iter()
            .map(|&n| {
                let noise = rng.next_unit() * a;
                let cost = (a * n as f64 + noise).max(1.0);
                (n, cost as u64)
            })
            .collect();

        let fit = fit_power_law(&points).expect("expected a fit for 6 distinct n values");
        assert_eq!(
            classify(fit.exponent),
            ComplexityClass::LinearOrBetter,
            "linear series must not be flagged (exponent={})",
            fit.exponent
        );
    }

    #[test]
    fn returns_none_for_insufficient_points() {
        assert!(fit_power_law(&[]).is_none());
        assert!(fit_power_law(&[(5, 100)]).is_none());
        assert!(fit_power_law(&[(0, 100), (0, 200)]).is_none()); // n must be > 0
    }
}
