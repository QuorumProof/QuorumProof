# Tutorial 5 — Sharing a Credential and Revoking Access

| | |
|---|---|
| **Audience** | Credential holders |
| **Prerequisites** | A credential issued to you (Tutorial 3) |
| **Target length** | ~5 minutes |
| **Captions** | [05-share-and-revoke.en.vtt](../captions/05-share-and-revoke.en.vtt) |

**Learning goals** — by the end the viewer can:
1. Create a time-limited, optionally password-protected share link.
2. Understand what the recipient sees when validating it.
3. Revoke a share link.

---

### Scene 1 — Why share links (00:00–00:45)

**On screen:** `docs/privacy-guide.md`.

**Narration**
> You control who sees your credentials. Share links give a specific verifier time-limited access, and you can revoke them at any time.

### Scene 2 — Create a share link (00:45–02:15)

**On screen:**
```bash
curl -X POST $API/api/credentials/1/share \
  -H "content-type: application/json" \
  -d '{"subject":"<your G address>","expiry_hours":72,"permission":"view_only","password":"<optional>"}'
```

**Narration**
> Create a link for your credential. Set how many hours it lasts, between one and eight thousand seven hundred sixty, and choose view only or download. Adding a password is optional but recommended. The response contains a token; send it to the verifier through a private channel.

### Scene 3 — What the verifier sees (02:15–03:30)

**On screen:**
```bash
curl -X POST $API/api/credentials/share/validate \
  -H "content-type: application/json" \
  -d '{"token":"<token>","password":"<password>"}'
```

**Narration**
> The verifier validates the token, with the password if you set one. They get the credential ID, the permission, and when the link expires. After it expires the link stops working.

### Scene 4 — Revoke access (03:30–04:30)

**On screen:**
```bash
curl -X DELETE $API/api/credentials/share/<token>
```

**Narration**
> Changed your mind? Delete the share link. Any later attempt to validate it fails straight away.

### Scene 5 — Recap (04:30–05:00)

**On screen:** Tutorial index.

**Narration**
> Share for the shortest time that works, use a password, and revoke links you no longer need. That's the end of this series. Thanks for watching.

---

## Recap

- Links are time-limited (1–8760 hours) and scoped (`view_only` / `download`).
- Share tokens and passwords over a private channel only.
- `DELETE /api/credentials/share/:token` revokes immediately.

## Links

- [privacy-guide.md](../../privacy-guide.md)
- [api-response-examples.md#share-links](../../api-response-examples.md#share-links)
