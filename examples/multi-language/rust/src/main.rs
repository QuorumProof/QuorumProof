//! QuorumProof REST quickstart — Rust (`ureq` + `serde_json`).
//!
//! Implements the scenario in ../SPEC.md. Run:
//!
//! ```sh
//! QP_API_URL=http://localhost:3000 cargo run --quiet
//! ```

use serde_json::{json, Value};
use std::{env, process, time::Duration};

struct Client {
    agent: ureq::Agent,
    base_url: String,
    api_key: Option<String>,
}

impl Client {
    fn from_env() -> Self {
        let base_url = env::var("QP_API_URL").unwrap_or_else(|_| "http://localhost:3000".into());
        Client {
            agent: ureq::AgentBuilder::new().timeout(Duration::from_secs(10)).build(),
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key: env::var("QP_API_KEY").ok().filter(|k| !k.is_empty()),
        }
    }

    /// Send a JSON request; return (status, parsed_body).
    fn request(&self, method: &str, path: &str, body: Option<Value>) -> Result<(u16, Value), String> {
        let mut req = self
            .agent
            .request(method, &format!("{}{}", self.base_url, path))
            .set("Accept", "application/json");
        if let Some(key) = &self.api_key {
            req = req.set("x-api-key", key);
        }
        let result = match body {
            Some(b) => req.send_json(b),
            None => req.call(),
        };
        let resp = match result {
            Ok(resp) => resp,
            // Non-2xx responses still carry a Problem Details body.
            Err(ureq::Error::Status(_, resp)) => resp,
            Err(e) => return Err(e.to_string()),
        };
        let status = resp.status();
        let json = resp.into_json::<Value>().map_err(|e| e.to_string())?;
        Ok((status, json))
    }
}

fn fail(msg: String) -> ! {
    eprintln!("{msg}");
    process::exit(1);
}

fn main() {
    let client = Client::from_env();

    // 1. Fetch a credential.
    let cred = match client.request("GET", "/api/v2/credentials/42", None) {
        Ok((200, body)) => body,
        other => fail(format!("GET credential 42 failed: {other:?}")),
    };
    println!(
        "credential 42: type={} revoked={} issuer={}",
        cred["credential_type"],
        cred["revoked"],
        cred["issuer"].as_str().unwrap_or_default()
    );

    // 2. Batch-verify claims.
    let items = json!({ "items": [
        { "credential_id": 42, "claim_type": "HasDegree" },
        { "credential_id": 42, "claim_type": "HasDegree" },
        { "credential_id": 99, "claim_type": "HasLicense" },
    ]});
    let batch = match client.request("POST", "/api/verify/batch", Some(items)) {
        Ok((200, body)) => body,
        other => fail(format!("POST verify/batch failed: {other:?}")),
    };
    let s = &batch["summary"];
    println!(
        "batch: total={} verified={} not_found={} duplicates={}",
        s["total"], s["verified"], s["not_found"], s["duplicates_deduplicated"]
    );
    for r in batch["results"].as_array().into_iter().flatten() {
        println!(
            "  {} {} -> {}",
            r["credential_id"],
            r["claim_type"].as_str().unwrap_or_default(),
            r["status"].as_str().unwrap_or_default()
        );
    }

    // 3. Handle a missing credential.
    let problem = match client.request("GET", "/api/v2/credentials/99", None) {
        Ok((404, body)) => body,
        other => fail(format!("GET credential 99: expected 404, got {other:?}")),
    };
    println!(
        "credential 99: not found ({})",
        problem["title"].as_str().unwrap_or_default()
    );
}
