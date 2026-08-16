use anyhow::{anyhow, Result};
use reqwest::Client;
use serde_json::{json, Value};
use std::env;
use std::time::Duration;

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
                "method": "getLedger",
                "params": []
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
                "params": []
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
        if let Ok(client) = StellarE2EClient::new(Network::Testnet) {
            match client.health_check().await {
                Ok(healthy) => {
                    assert!(healthy, "Testnet should be reachable");
                }
                Err(_) => {
                    eprintln!("Warning: Testnet is not reachable (this may be expected in CI)");
                }
            }
        }
    }

    #[tokio::test]
    async fn test_get_current_ledger() {
        if let Ok(client) = StellarE2EClient::new(Network::Testnet) {
            match client.get_ledger().await {
                Ok(_ledger) => {
                    println!("Successfully retrieved ledger from testnet");
                }
                Err(_) => {
                    eprintln!("Warning: Could not retrieve ledger (this may be expected in CI)");
                }
            }
        }
    }

    #[tokio::test]
    async fn test_network_passphrase_verification() {
        if let Ok(client) = StellarE2EClient::new(Network::Testnet) {
            match client.get_network().await {
                Ok(passphrase) => {
                    assert!(
                        passphrase.contains("Test SDF Network"),
                        "Passphrase mismatch for testnet"
                    );
                }
                Err(_) => {
                    eprintln!("Warning: Could not verify network passphrase (this may be expected in CI)");
                }
            }
        }
    }
}
