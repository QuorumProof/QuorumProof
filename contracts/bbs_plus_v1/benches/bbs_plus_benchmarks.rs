// BBS+ benchmarks: signing, selective-disclosure proof generation, and
// presentation verification, measured across message counts.
//
// Timing is wall-clock: each (operation, message count) pair takes the median
// of `SAMPLES` runs. For every operation we least-squares fit
// log(time) against log(n); the slope is the empirical complexity exponent
// (~1 means linear in message count).
//
// Results are printed as `BBS_BENCH <op> ...` lines, which CI greps for to
// make sure the bench target is not an empty stub. When
// `BBS_BENCH_RECORD_HISTORY=1` is set, one JSONL line per operation is also
// appended to `benches/history/bbs_plus_<op>.jsonl`, using the same
// `HistoryEntry` shape as the scaling benchmarks in `benches/src/history.rs`.
// Field mapping for BBS+ entries:
//   cpu_at_n_max -> median wall-clock nanoseconds at the largest n
//   mem_at_n_max -> serialized size in bytes of the artifact at the largest n
//                   (signature for sign, proof for prove and verify)

use bbs_plus_v1::{BbsPresentation, BbsSignature, Fr, SigningKey, VerifyingKey};
use rand::rngs::StdRng;
use rand::SeedableRng;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

const MESSAGE_COUNTS: &[u32] = &[1, 2, 4, 8, 16];
const SAMPLES: usize = 5;
const CONTEXT_ID: &[u8] = b"bbs-plus-bench-ctx";
const PRESENTATION_CONTEXT: &[u8] = b"bbs-plus-bench-nonce";
const REVEALED_INDEX: u32 = 0;

struct OpResult {
    op: &'static str,
    // (message count, median nanoseconds, artifact bytes)
    points: Vec<(u32, u128, usize)>,
}

fn median_ns<F: FnMut()>(mut f: F) -> u128 {
    let mut samples: Vec<u128> = (0..SAMPLES)
        .map(|_| {
            let start = Instant::now();
            f();
            start.elapsed().as_nanos()
        })
        .collect();
    samples.sort_unstable();
    samples[SAMPLES / 2]
}

/// Least-squares fit of log(y) = slope * log(x) + intercept.
/// Returns (slope, r_squared). Degenerate inputs yield (0.0, 0.0).
fn fit_loglog(points: &[(f64, f64)]) -> (f64, f64) {
    let xs: Vec<f64> = points.iter().map(|(x, _)| x.ln()).collect();
    let ys: Vec<f64> = points.iter().map(|(_, y)| y.ln()).collect();
    let n = xs.len() as f64;
    let mean_x = xs.iter().sum::<f64>() / n;
    let mean_y = ys.iter().sum::<f64>() / n;
    let sxx: f64 = xs.iter().map(|x| (x - mean_x).powi(2)).sum();
    let syy: f64 = ys.iter().map(|y| (y - mean_y).powi(2)).sum();
    let sxy: f64 = xs.iter().zip(&ys).map(|(x, y)| (x - mean_x) * (y - mean_y)).sum();
    if sxx == 0.0 || syy == 0.0 {
        return (0.0, 0.0);
    }
    let slope = sxy / sxx;
    let r_squared = (sxy * sxy) / (sxx * syy);
    (slope, r_squared)
}

fn bench_operations() -> Vec<OpResult> {
    let mut sign = OpResult { op: "sign", points: Vec::new() };
    let mut prove = OpResult { op: "prove", points: Vec::new() };
    let mut verify = OpResult { op: "verify", points: Vec::new() };

    for &n in MESSAGE_COUNTS {
        let mut rng = StdRng::seed_from_u64(1000 + n as u64);
        let sk = SigningKey::generate(&mut rng);
        let vk = VerifyingKey::derive(sk.public_key(), CONTEXT_ID, n).expect("derive verifying key");
        let messages: Vec<Fr> = (0..n as u64).map(|i| Fr::from_u64(i + 1)).collect();

        // Sign: fresh (e, s) per call, as the scheme requires.
        let sig_bytes = {
            let sig = BbsSignature::sign(&mut rng, &sk, &vk, &messages).expect("sign");
            sig.to_bytes().len()
        };
        let sign_ns = median_ns(|| {
            BbsSignature::sign(&mut rng, &sk, &vk, &messages).expect("sign");
        });
        sign.points.push((n, sign_ns, sig_bytes));

        // Prove: selective-disclosure presentation revealing one message.
        let sig = BbsSignature::sign(&mut rng, &sk, &vk, &messages).expect("sign");
        let proof = BbsPresentation::create_presentation(
            &mut rng,
            &sig,
            &vk,
            &messages,
            &[REVEALED_INDEX],
            PRESENTATION_CONTEXT,
        )
        .expect("create presentation");
        let proof_bytes = proof.to_bytes().len();
        let prove_ns = median_ns(|| {
            BbsPresentation::create_presentation(
                &mut rng,
                &sig,
                &vk,
                &messages,
                &[REVEALED_INDEX],
                PRESENTATION_CONTEXT,
            )
            .expect("create presentation");
        });
        prove.points.push((n, prove_ns, proof_bytes));

        // Verify: check the presentation proof against the verifying key.
        let verify_ns = median_ns(|| {
            let ok = BbsPresentation::verify_presentation(&vk, &proof, PRESENTATION_CONTEXT)
                .expect("verify presentation");
            assert!(ok, "valid presentation must verify");
        });
        verify.points.push((n, verify_ns, proof_bytes));
    }

    vec![sign, prove, verify]
}

fn history_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../benches/history")
}

fn record_history(result: &OpResult, commit: &str, timestamp: u64) -> std::io::Result<()> {
    let (n_max, ns_max, bytes_max) = *result.points.last().expect("at least one measurement");
    let xy: Vec<(f64, f64)> = result.points.iter().map(|&(n, ns, _)| (n as f64, ns as f64)).collect();
    let (exponent, r_squared) = fit_loglog(&xy);
    let finite = |v: f64| if v.is_finite() { v } else { 0.0 };

    let line = format!(
        r#"{{"commit":"{commit}","timestamp":"{timestamp}","n_max":{n_max},"exponent":{},"r_squared":{},"cpu_at_n_max":{ns_max},"mem_at_n_max":{bytes_max}}}"#,
        finite(exponent),
        finite(r_squared),
    );

    fs::create_dir_all(history_dir())?;
    let path = history_dir().join(format!("bbs_plus_{}.jsonl", result.op));
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{line}")
}

fn main() {
    let results = bench_operations();

    let commit = std::env::var("GITHUB_SHA").unwrap_or_else(|_| "unknown".to_string());
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let record = std::env::var("BBS_BENCH_RECORD_HISTORY").map(|v| v == "1").unwrap_or(false);

    for result in &results {
        let xy: Vec<(f64, f64)> = result.points.iter().map(|&(n, ns, _)| (n as f64, ns as f64)).collect();
        let (exponent, r_squared) = fit_loglog(&xy);
        for &(n, ns, bytes) in &result.points {
            println!("BBS_BENCH {} n={} median_ns={} artifact_bytes={}", result.op, n, ns, bytes);
        }
        println!(
            "BBS_BENCH {} fit exponent={:.3} r_squared={:.3}",
            result.op, exponent, r_squared
        );

        if record {
            record_history(result, &commit, timestamp).expect("append BBS+ benchmark history");
        }
    }
}
