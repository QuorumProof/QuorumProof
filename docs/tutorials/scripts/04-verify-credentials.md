# Tutorial 4 — Verifying Credentials Through the REST API

| | |
|---|---|
| **Audience** | Verifiers: employers, recruiting firms, compliance teams |
| **Prerequisites** | An API server URL and API key; credential IDs to check |
| **Target length** | ~6 minutes |
| **Captions** | [04-verify-credentials.en.vtt](../captions/04-verify-credentials.en.vtt) |

**Learning goals** — by the end the viewer can:
1. Look up a credential by ID.
2. Verify many claims at once with the batch endpoint.
3. Interpret each result status and handle errors.

---

### Scene 1 — The verifier's view (00:00–00:45)

**On screen:** `docs/api-response-examples.md` open at "Verification".

**Narration**
> As a verifier, you don't need a Stellar wallet. You call the QuorumProof REST API with an API key and get a signed-off answer backed by the ledger.

### Scene 2 — Look up a credential (00:45–02:00)

**On screen:**
```bash
export API=http://localhost:3000
curl -H "x-api-key: $QP_API_KEY" $API/api/credentials/1
```

**Narration**
> Start by fetching the credential. The response shows the issuer, the subject, the credential type, the metadata hash, and whether it's been revoked or has expired.

### Scene 3 — Batch verification (02:00–04:00)

**On screen:**
```bash
curl -X POST $API/api/verify/batch \
  -H "content-type: application/json" \
  -H "x-api-key: $QP_API_KEY" \
  -d '{"items":[
        {"credential_id":1,"claim_type":"HasDegree"},
        {"credential_id":2,"claim_type":"HasLicense"}
      ]}'
```

**Narration**
> To check many candidates, use the batch endpoint. Send a list of credential IDs and claim types. Duplicates are merged automatically. Each result has a status: verified, failed, not found, revoked, expired, or error. The summary at the bottom gives the totals.

### Scene 4 — Handling errors (04:00–05:15)

**On screen:** Trigger a `400` with an empty `items` array; show the Problem Details body. Show a `429` and its `Retry-After` header.

**Narration**
> Errors follow the Problem Details standard, with a type, title, status, and detail. A four hundred means the request was invalid. A four twenty nine means you're rate limited; wait for the number of seconds in the Retry-After header, then try again.

### Scene 5 — Recap (05:15–06:00)

**On screen:** Tutorial index.

**Narration**
> You looked up a credential, verified a batch, and handled errors. Treat revoked and expired as hard failures, and record the digest in your own audit log. Next, holders learn how to share a credential with you.

---

## Recap

- `GET /api/credentials/:id` for a single lookup.
- `POST /api/verify/batch` for many; read `status` per item.
- Errors are RFC 9457 Problem Details; respect `Retry-After` on 429.

## Links

- [api-response-examples.md](../../api-response-examples.md)
- [api-client-guide.md](../../api-client-guide.md)
- [integration-patterns-guide.md](../../integration-patterns-guide.md)
