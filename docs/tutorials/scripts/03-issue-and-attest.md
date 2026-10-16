# Tutorial 3 — Issuing and Attesting a Credential

| | |
|---|---|
| **Audience** | Issuing institutions and attestors |
| **Prerequisites** | Tutorials 1 and 2 completed |
| **Target length** | ~7 minutes |
| **Captions** | [03-issue-and-attest.en.vtt](../captions/03-issue-and-attest.en.vtt) |

**Learning goals** — by the end the viewer can:
1. Hash credential metadata off-chain.
2. Issue a credential with `issue_credential`.
3. Attest to it from slice members until quorum is reached.

---

### Scene 1 — Keep personal data off-chain (00:00–01:15)

**On screen:**
```bash
cat degree.json
sha256sum degree.json
```

**Narration**
> Ledger data is public, so personal details never go on-chain. The issuer keeps the credential document off-chain and publishes only its SHA-256 hash. Anyone holding the document can later prove it matches the hash.

### Scene 2 — Issue the credential (01:15–03:00)

**On screen:**
```bash
HASH=$(sha256sum degree.json | cut -d' ' -f1)
stellar contract invoke --id "$QP" --source university --network testnet \
  -- issue_credential \
  --issuer "$(stellar keys address university)" \
  --subject "$(stellar keys address holder)" \
  --credential_type 1 \
  --metadata_hash "$HASH" \
  --nonce 1
```

**Narration**
> The university issues the credential. It signs as the issuer, names the holder as subject, sets credential type one for a degree, and passes the metadata hash. The nonce prevents the same issuance from being replayed. The contract returns the credential ID.

### Scene 3 — Attest from slice members (03:00–05:00)

**On screen:**
```bash
for who in university society; do
  stellar contract invoke --id "$QP" --source "$who" --network testnet \
    -- attest \
    --attestor "$(stellar keys address $who)" \
    --credential_id 1 --slice_id 1 --attestation_value true
done
```

**Narration**
> Now the slice members attest. Each attestor signs with its own key and states true to confirm the credential. We'll have the university and the society attest. Their weights add up to eighty, which is above our threshold of sixty.

### Scene 4 — Check quorum (05:00–06:15)

**On screen:**
```bash
stellar contract invoke --id "$QP" --network testnet \
  -- is_attested --credential_id 1 --slice_id 1
curl http://localhost:3000/api/slices/1/verification
```

**Narration**
> Check the result with is_attested; it returns true. The REST endpoint shows the same, with the attested weight and whether the answer came from cache.

### Scene 5 — Recap (06:15–07:00)

**On screen:** `docs/issuer-security-checklist.md`.

**Narration**
> You issued a credential without putting personal data on-chain, and collected enough attestations to reach quorum. Issuers should protect their keys with hardware wallets; see the issuer security checklist. Next, we'll verify credentials as an employer.

---

## Recap

- Hash off-chain, store only the hash.
- `issue_credential` needs the issuer's signature and a unique nonce.
- Each attestor signs its own `attest` call; quorum is weight-based.

## Links

- [sbt-lifecycle.md](../../sbt-lifecycle.md)
- [issuer-security-checklist.md](../../issuer-security-checklist.md)
- [attestor-key-custody-guide.md](../../attestor-key-custody-guide.md)
- [credential-types.md](../../credential-types.md)
