use anyhow::{anyhow, Result};
use reqwest::Client;
use serde_json::{json, Value};
use std::env;
use std::time::Duration;
use tokio::time::sleep;

/// Retry a fallible async operation with exponential backoff.
///
/// `max_attempts` must be >= 1.  Delays are 1 s, 2 s, 4 s, … up to
/// `max_delay`.  The last attempt's error is returned when all attempts
/// are exhausted.
async fn retry_with_backoff<F, Fut, T>(
    max_attempts: u32,
    max_delay: Duration,
    mut f: F,
) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let mut delay = Duration::from_secs(1);
    for attempt in 1..=max_attempts {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                if attempt == max_attempts {
                    return Err(e);
                }
                eprintln!(
                    "Attempt {}/{} failed: {}. Retrying in {:?}…",
                    attempt, max_attempts, e, delay
                );
                sleep(delay).await;
                delay = (delay * 2).min(max_delay);
            }
        }
    }
    unreachable!()
}

pub struct StellarE2EClient {
    rpc_url: String,
    network: Network,
    client: Client,
}

#[derive(Clone, Copy, Debug)]
pub enum Network {
    Testnet,
    Futurenet,
    Standalone,
}

impl Network {
    pub fn rpc_url(&self) -> &'static str {
        match self {
            Network::Testnet => "https://soroban-testnet.stellar.org",
            Network::Futurenet => "https://rpc-futurenet.stellar.org",
            Network::Standalone => "http://localhost:8000/soroban/rpc",
        }
    }

    pub fn network_passphrase(&self) -> &'static str {
        match self {
            Network::Testnet => "Test SDF Network ; September 2015",
            Network::Futurenet => "Test SDF Future Network ; October 2022",
            Network::Standalone => "Standalone Network ; February 2017",
        }
    }
}

impl StellarE2EClient {
    pub fn new(network: Network) -> Result<Self> {
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()?;

        Ok(Self {
            rpc_url: network.rpc_url().to_string(),
            network,
            client,
        })
    }

    pub async fn get_ledger(&self) -> Result<Value> {
        let response = self
            .client
            .post(&self.rpc_url)
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "getLatestLedger",
                "params": {}
            }))
            .send()
            .await?;

        let body = response.json::<Value>().await?;
        if body["result"].get("sequence").is_none() {
            return Err(anyhow!("Failed to get ledger sequence"));
        }
        Ok(body)
    }

    pub async fn get_network(&self) -> Result<String> {
        let response = self
            .client
            .post(&self.rpc_url)
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "getNetwork",
                "params": {}
            }))
            .send()
            .await?;

        let body = response.json::<Value>().await?;
        Ok(body["result"]["passphrase"]
            .as_str()
            .ok_or_else(|| anyhow!("Failed to get network passphrase"))?
            .to_string())
    }

    pub async fn health_check(&self) -> Result<bool> {
        match self.get_ledger().await {
            Ok(_) => Ok(true),
            Err(_) => Ok(false),
        }
    }

    pub async fn is_network_reachable(&self) -> Result<bool> {
        let response = self.client.head(&self.rpc_url).send().await?;
        Ok(response.status().is_success())
    }

    pub fn network(&self) -> Network {
        self.network
    }

    pub fn rpc_url(&self) -> &str {
        &self.rpc_url
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_network_reachability() {
        let client = StellarE2EClient::new(Network::Testnet)
            .expect("failed to build HTTP client");
        // Allow up to 3 attempts for transient network flakiness.
        let healthy = retry_with_backoff(3, Duration::from_secs(8), || async {
            client.health_check().await
        })
        .await
        .expect("health_check returned an error after retries");
        assert!(healthy, "Testnet RPC endpoint is not reachable");
    }

    #[tokio::test]
    async fn test_get_current_ledger() {
        let client = StellarE2EClient::new(Network::Testnet)
            .expect("failed to build HTTP client");
        // Retry up to 3 times for transient connectivity issues.
        let ledger = retry_with_backoff(3, Duration::from_secs(8), || async {
            client.get_ledger().await
        })
        .await
        .expect("getLatestLedger RPC call failed after retries");
        assert!(
            ledger["result"]["sequence"].as_u64().unwrap_or(0) > 0,
            "ledger sequence must be a positive integer"
        );
    }

    #[tokio::test]
    async fn test_network_passphrase_verification() {
        let client = StellarE2EClient::new(Network::Testnet)
            .expect("failed to build HTTP client");
        // Retry for transient network errors; passphrase mismatch is a real failure.
        let passphrase = retry_with_backoff(3, Duration::from_secs(8), || async {
            client.get_network().await
        })
        .await
        .expect("getNetwork RPC call failed after retries");
        assert!(
            passphrase.contains("Test SDF Network"),
            "Passphrase mismatch for testnet: got '{}'",
            passphrase
        );
    }
}
