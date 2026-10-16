#!/usr/bin/env python3
"""QuorumProof REST quickstart — Python (standard library only).

Implements the scenario in ../SPEC.md. Run:
    QP_API_URL=http://localhost:3000 python3 quickstart.py
"""

import json
import os
import sys
import urllib.error
import urllib.request

BASE_URL = os.environ.get("QP_API_URL", "http://localhost:3000").rstrip("/")
API_KEY = os.environ.get("QP_API_KEY")


def request(method, path, body=None):
    """Send a JSON request; return (status, parsed_body)."""
    headers = {"Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if API_KEY:
        headers["x-api-key"] = API_KEY
    req = urllib.request.Request(BASE_URL + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as err:
        # Non-2xx responses still carry a Problem Details body.
        return err.code, json.load(err)


def main():
    # 1. Fetch a credential.
    status, cred = request("GET", "/api/v2/credentials/42")
    if status != 200:
        sys.exit(f"GET credential 42 failed: HTTP {status}")
    print(f"credential 42: type={cred['credential_type']} "
          f"revoked={str(cred['revoked']).lower()} issuer={cred['issuer']}")

    # 2. Batch-verify claims.
    items = [
        {"credential_id": 42, "claim_type": "HasDegree"},
        {"credential_id": 42, "claim_type": "HasDegree"},
        {"credential_id": 99, "claim_type": "HasLicense"},
    ]
    status, batch = request("POST", "/api/verify/batch", {"items": items})
    if status != 200:
        sys.exit(f"POST verify/batch failed: HTTP {status}")
    s = batch["summary"]
    print(f"batch: total={s['total']} verified={s['verified']} "
          f"not_found={s['not_found']} duplicates={s['duplicates_deduplicated']}")
    for r in batch["results"]:
        print(f"  {r['credential_id']} {r['claim_type']} -> {r['status']}")

    # 3. Handle a missing credential.
    status, problem = request("GET", "/api/v2/credentials/99")
    if status != 404:
        sys.exit(f"GET credential 99: expected 404, got HTTP {status}")
    print(f"credential 99: not found ({problem['title']})")


if __name__ == "__main__":
    main()
