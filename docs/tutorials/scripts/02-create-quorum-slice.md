# Tutorial 2 — Creating a Quorum Slice

| | |
|---|---|
| **Audience** | Credential holders and integrators |
| **Prerequisites** | Tutorial 1 completed; three funded testnet identities for attestors |
| **Target length** | ~6 minutes |
| **Captions** | [02-create-quorum-slice.en.vtt](../captions/02-create-quorum-slice.en.vtt) |

**Learning goals** — by the end the viewer can:
1. Explain what a quorum slice, attestor weight, and threshold are.
2. Create a weighted slice on testnet.
3. Read the slice back through the contract and the REST API.

---

### Scene 1 — What is a quorum slice? (00:00–01:15)

**On screen:** Diagram from `docs/quorum-slice-guide.md`.

**Narration**
> A quorum slice is your personal trust network. It lists the institutions you trust to vouch for you, such as your university, your licensing body, and a former employer. Each attestor has a weight from one to one hundred, and the slice has a threshold. A credential is trusted once the combined weight of attestors who signed it reaches that threshold.

### Scene 2 — Prepare identities (01:15–02:15)

**On screen:**
```bash
stellar keys generate holder --network testnet
stellar keys generate university --network testnet
stellar keys generate society --network testnet
stellar keys generate employer --network testnet
export QP=<quorum_proof contract id>
```

**Narration**
> For this demo we'll create four testnet identities: the holder, a university, an engineering society, and an employer. Export the quorum_proof contract ID from the previous video so we can reuse it.

### Scene 3 — Create the slice (02:15–04:00)

**On screen:**
```bash
stellar contract invoke --id "$QP" --source holder --network testnet \
  -- create_slice \
  --creator "$(stellar keys address holder)" \
  --attestors "[\"$(stellar keys address university)\",\"$(stellar keys address society)\",\"$(stellar keys address employer)\"]" \
  --weights '[40, 40, 20]' \
  --threshold 60
```

**Narration**
> Now call create_slice. The holder is the creator and signs the transaction. We pass three attestors with weights forty, forty, and twenty, and a threshold of sixty. That means any two of the university and society, or either one plus the employer, is enough. The contract returns the new slice ID.

### Scene 4 — Read it back (04:00–05:15)

**On screen:**
```bash
stellar contract invoke --id "$QP" --network testnet -- get_slice --slice-id 1
curl http://localhost:3000/api/slices/1
```

**Narration**
> Let's read it back, first directly from the contract with get_slice, then through the REST API. Both show the same attestors, weights, and threshold. Verifiers will usually use the API.

### Scene 5 — Recap (05:15–06:00)

**On screen:** `docs/weighted-voting.md`.

**Narration**
> You created a weighted quorum slice and read it back two ways. Choose weights carefully; no single attestor should be able to reach the threshold alone unless you intend that. Next, we'll issue a credential and have the slice attest to it.

---

## Recap

- A slice = attestors + weights (1–100) + threshold.
- Only the creator can create or modify their slice; the call requires their signature.
- Avoid weights where one attestor alone meets the threshold.

## Links

- [quorum-slice-guide.md](../../quorum-slice-guide.md)
- [weighted-voting.md](../../weighted-voting.md)
- [api-response-examples.md#quorum-slices](../../api-response-examples.md#quorum-slices)
