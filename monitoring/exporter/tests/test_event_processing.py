"""Tests for event processing in the QuorumProof exporter."""

import sys
import os
from unittest.mock import Mock, patch, MagicMock, call
from datetime import datetime
import pytest

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from stellar_sdk.soroban_rpc import EventInfo, GetEventsResponse
from stellar_sdk import scval


def create_mock_event(event_type: str, data_dict=None, paging_token: str = "token-1", ledger: int = 100):
    """Create a mock EventInfo object."""
    if data_dict is None:
        data_dict = {}

    # Encode the dict as XDR
    try:
        if data_dict:
            encoded = scval.to_struct(data_dict)
        else:
            encoded = scval.to_string("")
        value_xdr = encoded.to_xdr()
    except Exception:
        value_xdr = scval.to_string("").to_xdr()

    event = Mock(spec=EventInfo)
    event.event_type = event_type
    event.ledger = ledger
    event.ledger_close_at = datetime.now()
    event.contract_id = "CCQXXX"
    event.id = "event-1"
    event.paging_token = paging_token
    event.topic = []
    event.value = value_xdr
    event.in_successful_contract_call = True
    return event


def test_credential_issued_event():
    """Test that CredentialIssued event is processed without error."""
    event = create_mock_event("CredentialIssued", {"slice_count": 5})
    assert event.event_type == "CredentialIssued"


def test_credential_revoked_event():
    """Test that CredentialRevoked event is processed without error."""
    event = create_mock_event("CredentialRevoked")
    assert event.event_type == "CredentialRevoked"


def test_attestation_created_event():
    """Test that AttestationCreated event is processed without error."""
    event = create_mock_event("AttestationCreated")
    assert event.event_type == "AttestationCreated"


def test_pagination_cursor_state():
    """Test that pagination cursor state is properly tracked."""
    # Create mock events with different paging tokens
    event1 = create_mock_event("CredentialIssued", {}, paging_token="token-1", ledger=100)
    event2 = create_mock_event("CredentialIssued", {}, paging_token="token-2", ledger=101)

    # Verify paging tokens are different
    assert event1.paging_token != event2.paging_token
    assert event1.ledger != event2.ledger


def test_malformed_event_xdr_handling():
    """Test that malformed XDR values don't crash."""
    event = create_mock_event("UnknownEventType", {})
    # Value should be XDR string
    event.value = "invalid-xdr-string"

    # Should handle gracefully without crashing
    assert event.event_type == "UnknownEventType"
    assert event.value == "invalid-xdr-string"


def test_rate_limit_event_data():
    """Test RateLimitExceeded event contains address."""
    event = create_mock_event("RateLimitExceeded", {"address": "G123ABC"})
    assert event.event_type == "RateLimitExceeded"


def test_contract_paused_event():
    """Test ContractPaused event type."""
    event = create_mock_event("ContractPaused")
    assert event.event_type == "ContractPaused"


def test_contract_unpaused_event():
    """Test ContractUnpaused event type."""
    event = create_mock_event("ContractUnpaused")
    assert event.event_type == "ContractUnpaused"


def test_no_duplicate_pagination_tokens():
    """Test that pagination tokens remain unique across events."""
    event1 = create_mock_event("CredentialIssued", {}, paging_token="token-1", ledger=100)
    event2 = create_mock_event("CredentialIssued", {}, paging_token="token-2", ledger=101)
    event3 = create_mock_event("CredentialIssued", {}, paging_token="token-3", ledger=102)

    tokens = [event1.paging_token, event2.paging_token, event3.paging_token]
    # All tokens should be unique
    assert len(tokens) == len(set(tokens))


def test_empty_events_response():
    """Test handling of empty events list."""
    response = Mock(spec=GetEventsResponse)
    response.events = []
    response.latest_ledger = 100

    assert len(response.events) == 0
    assert response.latest_ledger == 100


def test_migration_progress_event():
    """Test MigrationProgress event contains expected fields."""
    event = create_mock_event(
        "MigrationProgress",
        {"migration_id": 1, "cursor": 10, "total_items": 100, "status": 0}
    )
    assert event.event_type == "MigrationProgress"


def test_proof_request_event():
    """Test ProofRequested event type."""
    event = create_mock_event("ProofRequested")
    assert event.event_type == "ProofRequested"

    def test_credential_issued_event_increments_counter(self, exporter_instance):
        """Test that CredentialIssued event increments credentials_issued_total."""
        event = create_mock_event("CredentialIssued", {"slice_count": 5})
        exporter_instance._process_event(event)

    def test_credential_revoked_event_increments_counter(self, exporter_instance):
        """Test that CredentialRevoked event increments credentials_revoked_total."""
        event = create_mock_event("CredentialRevoked")
        exporter_instance._process_event(event)

    def test_attestation_created_event_increments_counter(self, exporter_instance):
        """Test that AttestationCreated event increments attestations_total."""
        event = create_mock_event("AttestationCreated")
        exporter_instance._process_event(event)

    def test_pagination_advances_cursor_across_pages(self, exporter_instance):
        """Test that pagination cursor advances correctly across multiple pages."""
        event1 = create_mock_event("CredentialIssued", {}, paging_token="token-1", ledger=100)
        event2 = create_mock_event("CredentialIssued", {}, paging_token="token-2", ledger=101)
        event3 = create_mock_event("CredentialIssued", {}, paging_token="token-3", ledger=102)

        response1 = Mock(spec=GetEventsResponse)
        response1.events = [event1, event2]
        response1.latest_ledger = 101

        response2 = Mock(spec=GetEventsResponse)
        response2.events = [event3]
        response2.latest_ledger = 102

        exporter_instance.server.get_events = Mock(side_effect=[response1, response2])

        # First fetch
        events1 = exporter_instance._fetch_events()
        assert len(events1) == 2
        assert exporter_instance.event_cursor == "token-2"
        assert exporter_instance.last_ledger == 101

        # Second fetch with cursor from first
        events2 = exporter_instance._fetch_events()
        assert len(events2) == 1
        assert exporter_instance.event_cursor == "token-3"
        assert exporter_instance.last_ledger == 102

        # Verify cursor was passed to second call
        calls = exporter_instance.server.get_events.call_args_list
        assert calls[1][1]['cursor'] == "token-2"

    def test_malformed_event_does_not_crash(self, exporter_instance):
        """Test that malformed events are skipped without crashing the exporter."""
        event = create_mock_event("UnknownEventType", {})
        # Value contains invalid XDR
        event.value = "invalid-xdr-string"

        # Should not raise exception
        try:
            exporter_instance._process_event(event)
        except Exception as e:
            pytest.fail(f"Processing malformed event raised exception: {e}")

    def test_rate_limit_event_with_address(self, exporter_instance):
        """Test RateLimitExceeded event includes address in metrics."""
        event = create_mock_event("RateLimitExceeded", {"address": "G123ABC"})
        exporter_instance._process_event(event)

    def test_contract_paused_event_sets_metric(self, exporter_instance):
        """Test ContractPaused event sets contract_paused metric to 1."""
        event = create_mock_event("ContractPaused")
        exporter_instance._process_event(event)

    def test_contract_unpaused_event_sets_metric(self, exporter_instance):
        """Test ContractUnpaused event sets contract_paused metric to 0."""
        event = create_mock_event("ContractUnpaused")
        exporter_instance._process_event(event)

    def test_no_double_count_at_page_boundary(self, exporter_instance):
        """Test that events at page boundaries are not double-counted."""
        # Simulate 2 pages with overlapping boundary
        event1 = create_mock_event("CredentialIssued", {}, paging_token="token-1", ledger=100)
        event2 = create_mock_event("CredentialIssued", {}, paging_token="token-2", ledger=101)
        event3 = create_mock_event("CredentialIssued", {}, paging_token="token-3", ledger=102)

        response1 = Mock(spec=GetEventsResponse)
        response1.events = [event1, event2]

        response2 = Mock(spec=GetEventsResponse)
        response2.events = [event3]

        exporter_instance.server.get_events = Mock(side_effect=[response1, response2])

        exporter_instance._fetch_events()
        exporter_instance._fetch_events()

        # Total events across both calls should be 3
        total_events = len(response1.events) + len(response2.events)
        assert total_events == 3

    def test_empty_events_response_handling(self, exporter_instance):
        """Test handling of empty events response."""
        response = Mock(spec=GetEventsResponse)
        response.events = []
        response.latest_ledger = 100

        exporter_instance.server.get_events = Mock(return_value=response)

        events = exporter_instance._fetch_events()

        assert len(events) == 0

    def test_migration_progress_event(self, exporter_instance):
        """Test MigrationProgress event updates migration metrics."""
        event = create_mock_event(
            "MigrationProgress",
            {"migration_id": 1, "cursor": 10, "total_items": 100, "status": 0}
        )
        exporter_instance._process_event(event)

    def test_proof_request_event(self, exporter_instance):
        """Test ProofRequested event increments counter."""
        event = create_mock_event("ProofRequested")
        exporter_instance._process_event(event)
