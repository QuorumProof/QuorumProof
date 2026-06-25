# Rate Limiting and DDoS Protection

## Overview

Comprehensive rate limiting and DDoS protection for the QuorumProof API server, preventing abuse including credential brute-forcing, proof flooding, and resource exhaustion attacks.

## Rate Limiting

### Configuration

Rate limiting is applied globally to all `/api/*` routes via centralized middleware.

| Parameter | Default | Description |
|---|---|---|
| `windowMs` | 60000 (1 minute) | Duration of the rate limit window |
| `max` | 100 | Maximum requests per window per client |
| `backoffMultiplier` | 2 | Multiplier for exponential backoff duration |
| `maxViolations` | 5 | Number of violations before permanent block |

### Client Identification

Clients are identified using a combined strategy:

1. **Authenticated users**: If the `X-Stellar-Address` header is present, it is used as the client identifier. This prevents IP-based bypass techniques for wallet-authenticated users.
2. **Anonymous users**: Falls back to the client IP address (`req.ip`), respecting `X-Forwarded-For` when `trust proxy` is enabled.

### Rate Limit Headers

Every API response includes the following headers:

| Header | Description | Example |
|---|---|---|
| `X-RateLimit-Limit` | Maximum requests allowed in the window | `100` |
| `X-RateLimit-Remaining` | Requests remaining in the current window | `87` |
| `X-RateLimit-Reset` | Unix timestamp when the window resets | `1719300000` |
| `Retry-After` | Seconds to wait before retrying (on 429 only) | `60` |

### 429 Response Body

```json
{
  "error": "Rate limit exceeded",
  "message": "Too many requests. Limit: 100 per 60s. Retry after 60s.",
  "retryAfter": 60,
  "limit": 100,
  "windowMs": 60000
}
```

### Exponential Backoff

When a client exceeds the rate limit, the violation is tracked across windows. Each subsequent violation results in a longer backoff period:

- **1st violation**: `windowMs * 1` (e.g., 60s wait)
- **2nd violation**: `windowMs * 2` (e.g., 120s wait)
- **3rd violation**: `windowMs * 4` (e.g., 240s wait)
- **Nth violation**: `windowMs * 2^(N-1)`

After `maxViolations` (default: 5) violations, the client is permanently blocked until the server reset.

### Testing

```bash
# Test rate limit headers
curl -I http://localhost:3000/api/analytics/summary

# Trigger rate limit (replace with your IP)
for i in $(seq 1 101); do curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/slices; done | sort | uniq -c
```

## DDoS Protection

### Request Body Size Limiting

Requests with bodies exceeding 100 KB are rejected with HTTP 413 (Request Entity Too Large). This prevents memory exhaustion attacks via oversized payloads.

### Burst Detection

Rapid requests from the same IP within a short window are throttled:

- **Window**: 2 seconds
- **Max requests per window**: 20
- **Action**: HTTP 429 with `"Request burst detected"` message

### Concurrent Request Limiting

Maximum concurrent requests per IP are capped at 20. Additional requests receive HTTP 429 with `"Too many concurrent requests"` message.

## Programmatic Usage

```typescript
import { createRateLimiter } from './middleware/rateLimiter.js';
import { createDDoSProtection } from './middleware/ddosProtection.js';

// Custom rate limiter for sensitive endpoints (e.g., credential verification)
const strictLimiter = createRateLimiter({
  windowMs: 60000,
  max: 20,
  name: 'strict',
  backoffMultiplier: 4,
  maxViolations: 3,
});

// Apply to specific routes
router.post('/verify-batch', strictLimiter, handler);
```

## Implementation Details

- **Storage**: In-memory `Map` (per-server instance). Not shared across horizontal scale-out.
- **Cleanup**: Entries are garbage-collected when windows expire. The `reset()` method clears all state (useful for testing).
- **Key Functions**: `ipKey`, `userKey`, and `combinedKey` are exported for custom middleware composition.
