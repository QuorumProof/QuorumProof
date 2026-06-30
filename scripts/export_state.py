#!/usr/bin/env python3
"""
Issue #591: Export contract state to JSON or CSV for off-chain analysis.

Usage:
  python3 scripts/export_state.py --format json [--credential-id 42] [--out state.json]
  python3 scripts/export_state.py --format csv  [--out state.csv]

Requires: stellar-sdk  (pip install stellar-sdk)
Env vars: STELLAR_RPC_URL, CONTRACT_QUORUM_PROOF
"""
import argparse
import csv
import json
import os
import sys

try:
    from stellar_sdk import SorobanServer
    from stellar_sdk.soroban_rpc import GetLedgerEntriesRequest
except ImportError:
    sys.exit("stellar-sdk not installed. Run: pip install stellar-sdk")


def get_env(key: str) -> str:
    val = os.environ.get(key)
    if not val:
        sys.exit(f"Missing env var: {key}")
    return val


def fetch_credential(server: SorobanServer, contract_id: str, cred_id: int) -> dict | None:
    """Call get_credential via JSON-RPC simulation and return a plain dict."""
    from stellar_sdk import Keypair, Network, TransactionBuilder, Account
    from stellar_sdk.xdr import SCVal
    import stellar_sdk.scval as scval

    # Build a read-only simulation (no auth needed for view functions)
    source = Keypair.random()
    account = Account(source.public_key, 0)
    tx = (
        TransactionBuilder(account, Network.TESTNET_NETWORK_PASSPHRASE, base_fee=100)
        .append_invoke_contract_function_op(
            contract_id=contract_id,
            function_name="get_credential",
            parameters=[scval.to_uint64(cred_id)],
        )
        .build()
    )
    resp = server.simulate_transaction(tx)
    if resp.error:
        return None
    # Parse the first result XDR
    result_xdr = resp.results[0].xdr if resp.results else None
    if not result_xdr:
        return None
    val = SCVal.from_xdr(result_xdr)
    # Convert SCVal map to plain dict (best-effort)
    return _scval_to_dict(val)


def _scval_to_dict(val) -> dict:
    """Recursively convert an SCVal to a JSON-serialisable Python object."""
    from stellar_sdk.xdr.sc_val_type import SCValType
    t = val.type
    if t == SCValType.SCV_MAP and val.map:
        return {
            _scval_to_dict(e.key): _scval_to_dict(e.val)
            for e in val.map.sc_map
        }
    if t == SCValType.SCV_VEC and val.vec:
        return [_scval_to_dict(i) for i in val.vec.sc_vec]
    if t in (SCValType.SCV_UINT64, SCValType.SCV_INT64):
        return val.u64.uint64 if t == SCValType.SCV_UINT64 else val.i64.int64
    if t == SCValType.SCV_BOOL:
        return val.b
    if t == SCValType.SCV_STRING:
        return val.str.sc_string.decode()
    if t == SCValType.SCV_SYMBOL:
        return val.sym.sc_symbol.decode()
    if t == SCValType.SCV_ADDRESS:
        return str(val.address)
    return repr(val)


def batch_export(server: SorobanServer, contract_id: str, max_id: int) -> list[dict]:
    records = []
    for cid in range(1, max_id + 1):
        rec = fetch_credential(server, contract_id, cid)
        if rec:
            rec["credential_id"] = cid
            records.append(rec)
    return records


def write_json(records: list[dict], path: str) -> None:
    with open(path, "w") as f:
        json.dump(records, f, indent=2, default=str)
    print(f"Exported {len(records)} records → {path}")


def write_csv(records: list[dict], path: str) -> None:
    if not records:
        print("No records to export.")
        return
    fields = list(records[0].keys())
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(records)
    print(f"Exported {len(records)} records → {path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Export QuorumProof contract state")
    parser.add_argument("--format", choices=["json", "csv"], default="json")
    parser.add_argument("--credential-id", type=int, help="Export a single credential by ID")
    parser.add_argument("--max-id", type=int, default=1000, help="Upper bound for batch export")
    parser.add_argument("--out", default=None, help="Output file path")
    args = parser.parse_args()

    rpc_url = get_env("STELLAR_RPC_URL")
    contract_id = get_env("CONTRACT_QUORUM_PROOF")
    server = SorobanServer(rpc_url)

    if args.credential_id:
        rec = fetch_credential(server, contract_id, args.credential_id)
        records = [rec] if rec else []
    else:
        records = batch_export(server, contract_id, args.max_id)

    out = args.out or f"state.{args.format}"
    if args.format == "json":
        write_json(records, out)
    else:
        write_csv(records, out)


if __name__ == "__main__":
    main()
