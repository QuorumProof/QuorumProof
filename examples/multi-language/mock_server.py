#!/usr/bin/env python3
"""examples/multi-language/mock_server.py — #1638 Deterministic API stub for example tests.

Serves the three endpoints the multi-language examples call, with the
response shapes documented in docs/api-response-examples.md. Standard
library only.

Usage:
    python3 examples/multi-language/mock_server.py [PORT]   # default 8787
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

ISSUER = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZRXDMTGEYJ66SDOQ62RK"
SUBJECT = "GBVZHJRZMJXHE3RQXEKW3KRJM45OZDXOLYG35PNZGJDAZOFMFKQLM4H"

CREDENTIALS = {
    42: {
        "id": "42",
        "issuer": ISSUER,
        "subject": SUBJECT,
        "credential_type": 1,
        "metadata_hash": "a3f1b2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2",
        "revoked": False,
        "expires_at": None,
    }
}


def verify_one(item):
    cred = CREDENTIALS.get(item.get("credential_id"))
    if cred is None:
        return {"credential_id": item.get("credential_id"), "claim_type": item.get("claim_type"),
                "status": "not_found", "proof": None, "error": "Credential not found"}
    return {"credential_id": item["credential_id"], "claim_type": item["claim_type"],
            "status": "verified",
            "proof": {"verified_at": "2026-09-26T10:15:00.000Z",
                      "credential_status": "active", "digest": "9f2c61a0b4e7d3c1"},
            "error": None}


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, body, content_type="application/json"):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _not_found(self, detail):
        self._send(404, {"type": "about:blank", "title": "Credential not found",
                         "status": 404, "detail": detail}, "application/problem+json")

    def do_GET(self):
        prefix = "/api/v2/credentials/"
        if self.path.startswith(prefix) and self.path[len(prefix):].isdigit():
            cred_id = int(self.path[len(prefix):])
            if cred_id in CREDENTIALS:
                return self._send(200, CREDENTIALS[cred_id])
            return self._not_found(f"No credential with id {cred_id}")
        self._send(404, {"title": "Not Found", "status": 404})

    def do_POST(self):
        if self.path != "/api/verify/batch":
            return self._send(404, {"title": "Not Found", "status": 404})
        length = int(self.headers.get("Content-Length", 0))
        items = json.loads(self.rfile.read(length) or b"{}").get("items", [])
        results = [verify_one(i) for i in items]
        unique = {(i.get("credential_id"), i.get("claim_type")) for i in items}
        self._send(200, {
            "results": results,
            "summary": {
                "total": len(results),
                "verified": sum(r["status"] == "verified" for r in results),
                "failed": 0,
                "not_found": sum(r["status"] == "not_found" for r in results),
                "errors": 0,
                "duplicates_deduplicated": len(items) - len(unique),
                "execution_time_ms": 1,
            },
        })

    def log_message(self, *_):
        pass  # keep test output clean


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
