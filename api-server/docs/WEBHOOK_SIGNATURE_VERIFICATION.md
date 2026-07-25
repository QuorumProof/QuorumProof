# Webhook Signature Verification

## Overview

QuorumProof webhooks support HMAC-SHA256 signature verification to ensure that webhook events are authentically delivered by QuorumProof and have not been tampered with.

## How It Works

When you register a webhook with a secret, QuorumProof signs every webhook delivery with that secret using HMAC-SHA256:

1. **Generate a secret** during webhook registration (or provide your own)
2. **On each delivery**, QuorumProof computes: `HMAC-SHA256(secret, payload)` and sends it in the `X-QuorumProof-Signature` header
3. **Verify on receipt** by computing the same HMAC and comparing it to the header value

## Registering a Webhook with a Secret

```bash
curl -X POST https://api.quorumproof.io/api/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-api.example.com/webhook",
    "events": ["credential_issued", "credential_attested"],
    "secret": "your-secret-key"
  }'
```

The response includes the webhook ID (e.g., `wh_123`):

```json
{
  "id": "wh_123",
  "url": "https://your-api.example.com/webhook",
  "events": ["credential_issued", "credential_attested"],
  "secret": "your-secret-key",
  "createdAt": "2026-01-01T12:00:00.000Z"
}
```

**Note**: Store your secret securely. Use environment variables or a secrets manager; never commit secrets to version control.

## Webhook Delivery Headers

Every webhook delivery includes the following headers:

| Header | Value | Purpose |
|--------|-------|---------|
| `X-QuorumProof-Delivery-Id` | `dlv_123456` | Stable idempotency key; same for all retry attempts of the same delivery |
| `X-QuorumProof-Signature` | `sha256=abc123...` | HMAC-SHA256 signature of the request body |
| `Content-Type` | `application/json` | Always JSON |

## Client-Side Verification (Node.js)

### Using Crypto

```javascript
import crypto from 'crypto';

function verifyWebhookSignature(payload, secret, signatureHeader) {
  // Extract the signature (remove 'sha256=' prefix)
  const [algorithm, signature] = signatureHeader.split('=');
  
  if (algorithm !== 'sha256') {
    throw new Error(`Unexpected signature algorithm: ${algorithm}`);
  }

  // Compute the expected HMAC
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  // Constant-time comparison to prevent timing attacks
  if (!crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  )) {
    throw new Error('Invalid signature');
  }

  return true;
}

// Example Express middleware
export function webhookSignatureMiddleware(secret) {
  return (req, res, next) => {
    const sig = req.headers['x-quorumproof-signature'];
    
    if (!sig) {
      return res.status(401).json({ error: 'Missing X-QuorumProof-Signature header' });
    }

    try {
      // req.rawBody contains the raw request body as a string
      verifyWebhookSignature(req.rawBody, secret, sig);
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
  };
}
```

**Note:** You must pass the raw body (as a string) to the verification function, not the parsed JSON object. Most Express middleware will have already parsed the body, so you may need to capture the raw body separately.

### Capture Raw Body in Express

```javascript
import express from 'express';

const app = express();

// Capture raw body before JSON parsing
app.use((req, res, next) => {
  let rawBody = '';
  req.on('data', chunk => {
    rawBody += chunk.toString('utf8');
  });
  req.on('end', () => {
    req.rawBody = rawBody;
    next();
  });
});

// Parse JSON
app.use(express.json());

// Verify signature
app.use(webhookSignatureMiddleware(process.env.WEBHOOK_SECRET));

// Your webhook handler
app.post('/webhook', (req, res) => {
  const payload = req.body;
  console.log('Received verified webhook:', payload.event, payload.credential_id);
  res.json({ ok: true });
});
```

## Client-Side Verification (Python)

```python
import hmac
import hashlib

def verify_webhook_signature(payload: bytes, secret: str, signature_header: str) -> bool:
    """Verify the webhook signature."""
    algorithm, signature = signature_header.split('=', 1)
    
    if algorithm != 'sha256':
        raise ValueError(f'Unexpected signature algorithm: {algorithm}')
    
    expected_signature = hmac.new(
        secret.encode(),
        payload,
        hashlib.sha256
    ).hexdigest()
    
    # Constant-time comparison
    if not hmac.compare_digest(signature, expected_signature):
        raise ValueError('Invalid signature')
    
    return True

# Example Flask middleware
from flask import request, abort

def verify_webhook_flask():
    sig = request.headers.get('X-QuorumProof-Signature')
    if not sig:
        abort(401, 'Missing X-QuorumProof-Signature header')
    
    try:
        verify_webhook_signature(request.get_data(), process.env['WEBHOOK_SECRET'], sig)
    except ValueError as e:
        abort(401, str(e))

@app.before_request
def before_webhook():
    if request.path == '/webhook':
        verify_webhook_flask()

@app.route('/webhook', methods=['POST'])
def webhook():
    payload = request.get_json()
    print(f"Received verified webhook: {payload['event']} for credential {payload['credential_id']}")
    return {'ok': True}
```

## Client-Side Verification (Go)

```go
package main

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "strings"
)

func VerifyWebhookSignature(payload []byte, secret string, signatureHeader string) (bool, error) {
    parts := strings.Split(signatureHeader, "=")
    if len(parts) != 2 {
        return false, fmt.Errorf("invalid signature header format")
    }

    algorithm := parts[0]
    signature := parts[1]

    if algorithm != "sha256" {
        return false, fmt.Errorf("unexpected signature algorithm: %s", algorithm)
    }

    // Compute expected signature
    h := hmac.New(sha256.New, []byte(secret))
    h.Write(payload)
    expectedSignature := hex.EncodeToString(h.Sum(nil))

    // Compare (constant-time comparison)
    if !hmac.Equal([]byte(signature), []byte(expectedSignature)) {
        return false, fmt.Errorf("invalid signature")
    }

    return true, nil
}

// Example HTTP handler
func HandleWebhook(w http.ResponseWriter, r *http.Request) {
    sig := r.Header.Get("X-QuorumProof-Signature")
    if sig == "" {
        http.Error(w, "Missing X-QuorumProof-Signature header", http.StatusUnauthorized)
        return
    }

    payload, _ := ioutil.ReadAll(r.Body)
    valid, err := VerifyWebhookSignature(payload, os.Getenv("WEBHOOK_SECRET"), sig)
    if err != nil || !valid {
        http.Error(w, "Invalid signature", http.StatusUnauthorized)
        return
    }

    // Process webhook
    fmt.Println("Received verified webhook")
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusOK)
    w.Write([]byte(`{"ok":true}`))
}
```

## Best Practices

1. **Always verify signatures** — Never trust a webhook without verifying its signature first
2. **Use constant-time comparison** — Protect against timing attacks by using `timingSafeEqual` (Node.js), `compare_digest` (Python), or `hmac.Equal` (Go)
3. **Store secrets securely** — Use environment variables or secrets management systems
4. **Idempotency** — Use the `X-QuorumProof-Delivery-Id` header to deduplicate webhook deliveries (webhooks may be retried)
5. **Rate limiting** — Implement per-IP rate limiting on your webhook endpoint

## Signature Example

Given:
- **Secret**: `my-webhook-secret`
- **Payload**: `{"event":"credential_issued","credential_id":42,"timestamp":"2026-01-01T12:00:00.000Z"}`

The signature is computed as:

```
HMAC-SHA256(key="my-webhook-secret", msg='{"event":"credential_issued","credential_id":42,"timestamp":"2026-01-01T12:00:00.000Z"}')
= "a1b2c3d4e5f6..."
```

And sent as the header:

```
X-QuorumProof-Signature: sha256=a1b2c3d4e5f6...
```

## Webhook Delivery Guarantee

**Guarantee**: At-least-once delivery with idempotency keys.

- Webhooks are retried up to 3 times with exponential backoff (1s, 5s, 15s) on failure
- The `X-QuorumProof-Delivery-Id` header is the same for all retry attempts
- Your webhook handler should be idempotent — it may receive the same delivery multiple times

**Example**: If your endpoint accepts the webhook but the response is lost, QuorumProof will retry. Using the `X-QuorumProof-Delivery-Id`, you can detect and skip duplicate processing.

## Troubleshooting

### Signature verification failing

- **Check the header format**: Should be `sha256=<hex-string>` (64 hex characters)
- **Check the secret**: Ensure you're using the exact secret provided when registering the webhook
- **Check the raw body**: Always use the raw request body (as a string), not the parsed JSON object
- **Check the algorithm**: Only `sha256` is supported currently

### Webhooks not being delivered

- **Check the webhook URL**: Must be an accessible HTTPS endpoint that responds within 30 seconds
- **Check the circuit breaker**: If your endpoint fails repeatedly, QuorumProof may open a circuit breaker to prevent cascading failures
- **Check dead-letter queue**: Failed deliveries are stored; use `GET /api/webhooks/dead-letters` to see them
- **Replay a delivery**: Use `POST /api/webhooks/dead-letters/{id}/replay` to retry a failed delivery

## API Reference

### Register a Webhook

```bash
POST /api/webhooks
Content-Type: application/json

{
  "url": "https://your-endpoint.example.com/webhook",
  "events": ["credential_issued", "credential_attested", "credential_revoked"],
  "secret": "optional-secret-key"
}
```

**Response** (201 Created):

```json
{
  "id": "wh_123",
  "url": "https://your-endpoint.example.com/webhook",
  "events": ["credential_issued", "credential_attested", "credential_revoked"],
  "secret": "optional-secret-key",
  "createdAt": "2026-01-01T12:00:00.000Z"
}
```

### List Webhooks

```bash
GET /api/webhooks
```

### Get a Webhook

```bash
GET /api/webhooks/{id}
```

### Delete a Webhook

```bash
DELETE /api/webhooks/{id}
```

### List Delivery Log

```bash
GET /api/webhooks/deliveries/log
```

Returns all webhook deliveries (successful and failed).

### List Dead Letters

```bash
GET /api/webhooks/dead-letters
```

Returns deliveries that exhausted retries.

### Replay a Dead Letter

```bash
POST /api/webhooks/dead-letters/{id}/replay
```

Resets the attempts counter and retries the delivery.

## See Also

- [Webhook Service Design](../src/services/webhooks.ts)
- [Webhook Store & Durability](../src/services/webhookStore.ts)
- [Circuit Breaker Pattern](../src/services/webhookCircuitBreaker.ts)
