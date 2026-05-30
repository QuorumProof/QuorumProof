"""QuorumProof contract event exporter for Prometheus."""

import os
import json
import time
import logging
from typing import Optional, Dict, Any
from datetime import datetime

import requests
from prometheus_client import start_http_server, CollectorRegistry
from stellar_sdk import Server

from metrics import (
    registry,
    credentials_issued_total,
    credentials_revoked_total,
    attestations_total,
    api_errors_total,
    proof_requests_total,
    rate_limit_hits_total,
    attestation_success_rate,
    contract_paused,
    active_slices_total,
    contract_gas_usage,
    contract_state_size,
    api_request_duration_seconds,
    contract_invocation_duration_seconds,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class QuorumProofExporter:
    """Exports QuorumProof contract metrics to Prometheus."""

    def __init__(
        self,
        rpc_url: str,
        contract_id: str,
        scrape_interval: int = 15,
        exporter_port: int = 9101,
    ):
        self.rpc_url = rpc_url
        self.contract_id = contract_id
        self.scrape_interval = scrape_interval
        self.exporter_port = exporter_port
        self.server = Server(rpc_url)
        self.last_ledger = 0
        self.event_cache: Dict[str, Any] = {}

    def start(self):
        """Start the Prometheus HTTP server and begin scraping."""
        start_http_server(self.exporter_port, registry=registry)
        logger.info(f"Exporter listening on port {self.exporter_port}")

        while True:
            try:
                self.scrape()
            except Exception as e:
                logger.error(f"Scrape error: {e}")
                api_errors_total.labels(error_code="scrape_error").inc()

            time.sleep(self.scrape_interval)

    def scrape(self):
        """Fetch contract events and update metrics."""
        start_time = time.time()

        try:
            # Fetch contract events from RPC
            events = self._fetch_events()
            duration = time.time() - start_time
            api_request_duration_seconds.observe(duration)

            # Process events
            for event in events:
                self._process_event(event)

            logger.info(f"Scraped {len(events)} events in {duration:.2f}s")

        except requests.RequestException as e:
            logger.error(f"RPC request failed: {e}")
            api_errors_total.labels(error_code="rpc_error").inc()

    def _fetch_events(self) -> list:
        """Fetch contract events from Stellar RPC."""
        # Use Stellar RPC to get contract events
        # This is a simplified implementation; actual implementation depends on RPC API
        try:
            response = requests.get(
                f"{self.rpc_url}/events",
                params={
                    "contract_id": self.contract_id,
                    "start_ledger": self.last_ledger,
                    "limit": 1000,
                },
                timeout=10,
            )
            response.raise_for_status()
            data = response.json()

            if data.get("events"):
                self.last_ledger = data["events"][-1].get("ledger", self.last_ledger)

            return data.get("events", [])
        except Exception as e:
            logger.error(f"Failed to fetch events: {e}")
            return []

    def _process_event(self, event: Dict[str, Any]):
        """Process a contract event and update metrics."""
        event_type = event.get("type")
        data = event.get("data", {})

        if event_type == "CredentialIssued":
            credentials_issued_total.inc()
            active_slices_total.set(data.get("slice_count", 0))

        elif event_type == "CredentialRevoked":
            credentials_revoked_total.inc()

        elif event_type == "AttestationCreated":
            attestations_total.inc()
            # Update attestation success rate
            self._update_attestation_rate(data)

        elif event_type == "ProofRequested":
            proof_requests_total.inc()

        elif event_type == "RateLimitExceeded":
            address = data.get("address", "unknown")
            rate_limit_hits_total.labels(address=address).inc()

        elif event_type == "ContractPaused":
            contract_paused.set(1)

        elif event_type == "ContractUnpaused":
            contract_paused.set(0)

        elif event_type == "APIError":
            error_code = data.get("error_code", "unknown")
            api_errors_total.labels(error_code=error_code).inc()

        elif event_type == "GasUsage":
            operation = data.get("operation", "unknown")
            gas = data.get("gas_used", 0)
            contract_gas_usage.labels(operation=operation).set(gas)

        elif event_type == "StateSnapshot":
            size = data.get("state_size", 0)
            contract_state_size.set(size)

    def _update_attestation_rate(self, event_data: Dict[str, Any]):
        """Calculate and update attestation success rate."""
        try:
            total_credentials = event_data.get("total_credentials", 1)
            attested_credentials = event_data.get("attested_credentials", 0)

            if total_credentials > 0:
                rate = attested_credentials / total_credentials
                attestation_success_rate.set(rate)
        except Exception as e:
            logger.error(f"Failed to update attestation rate: {e}")

    def health_check(self) -> bool:
        """Check if the exporter is healthy."""
        try:
            response = requests.get(f"{self.rpc_url}/health", timeout=5)
            return response.status_code == 200
        except Exception as e:
            logger.error(f"Health check failed: {e}")
            return False


def main():
    """Main entry point."""
    rpc_url = os.getenv("STELLAR_RPC_URL", "https://soroban-testnet.stellar.org")
    contract_id = os.getenv("CONTRACT_QUORUM_PROOF")
    scrape_interval = int(os.getenv("SCRAPE_INTERVAL_SECONDS", "15"))
    exporter_port = int(os.getenv("EXPORTER_PORT", "9101"))

    if not contract_id:
        raise ValueError("CONTRACT_QUORUM_PROOF environment variable not set")

    exporter = QuorumProofExporter(
        rpc_url=rpc_url,
        contract_id=contract_id,
        scrape_interval=scrape_interval,
        exporter_port=exporter_port,
    )

    logger.info(f"Starting QuorumProof exporter")
    logger.info(f"  RPC URL: {rpc_url}")
    logger.info(f"  Contract ID: {contract_id}")
    logger.info(f"  Scrape interval: {scrape_interval}s")
    logger.info(f"  Exporter port: {exporter_port}")

    exporter.start()


if __name__ == "__main__":
    main()
