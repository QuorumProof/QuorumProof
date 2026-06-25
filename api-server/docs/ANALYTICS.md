# Credential Analytics and Audit Dashboard

## Overview

The Credential Analytics service provides real-time metrics and insights into credential operations across the QuorumProof network. It tracks issuance volumes, attestation patterns, revocations, and ecosystem health, with comprehensive data aggregation and anomaly detection.

## Features

### Core Capabilities

- **Real-time Event Logging**: Captures credential events (issued, attested, revoked, suspended, verified)
- **Time-Series Aggregation**: Hourly to daily metrics aggregation
- **Anomaly Detection**: Z-score based anomaly detection for unusual patterns
- **Rate Limiting**: Protects API endpoints with configurable rate limits
- **GDPR Compliance**: No personally identifiable information in aggregated metrics
- **Data Retention**: Configurable retention policy (default: 2 years)
- **Custom Time Ranges**: Query metrics across any date range

## API Endpoints

### POST /api/analytics/events

Records a credential event.

**Request Body:**
```json
{
  "type": "issued|attested|revoked|suspended|verified",
  "credential_id": "string",
  "timestamp": "ISO8601 timestamp",
  "issuer": "optional string",
  "subject": "optional string",
  "attestor": "optional string",
  "metadata": "optional object"
}
```

**Response:**
```json
{
  "success": true,
  "event_id": "credential_id"
}
```

**Status Codes:**
- 201: Event recorded successfully
- 400: Missing required fields or invalid event type
- 429: Rate limit exceeded

### GET /api/analytics/metrics

Retrieves aggregated metrics for a date range.

**Query Parameters:**
- `start_date`: YYYY-MM-DD format (default: 90 days ago)
- `end_date`: YYYY-MM-DD format (default: today)

**Response:**
```json
{
  "start_date": "2026-06-22",
  "end_date": "2026-06-25",
  "metrics": [
    {
      "date": "2026-06-22",
      "issued_count": 150,
      "attested_count": 45,
      "revoked_count": 12,
      "suspended_count": 3,
      "verified_count": 89,
      "unique_issuers": 8,
      "unique_subjects": 42,
      "unique_attestors": 5,
      "issuance_rate": 0.35,
      "revocation_rate": 0.03,
      "attestation_rate": 0.11,
      "anomaly_score": 0.5
    }
  ],
  "summary": {
    "total_issued": 450,
    "total_attested": 135,
    "total_revoked": 36
  }
}
```

**Status Codes:**
- 200: Metrics retrieved successfully
- 400: Invalid date range or format
- 429: Rate limit exceeded

### GET /api/analytics/anomalies

Detects anomalies in credential metrics using statistical analysis.

**Query Parameters:**
- `start_date`: YYYY-MM-DD format (default: 30 days ago)
- `end_date`: YYYY-MM-DD format (default: today)

**Response:**
```json
{
  "start_date": "2026-05-23",
  "end_date": "2026-06-25",
  "total_anomalies": 2,
  "anomalous_dates": [
    {
      "date": "2026-06-10",
      "issued_count": 5000,
      "anomaly_score": 4.2,
      "anomaly_details": {
        "is_anomalous": true,
        "score": 4.2,
        "reason": "Z-score: 4.20, exceeds threshold of 2.5",
        "zscore": 4.2,
        "expected_range": {
          "min": 0,
          "max": 500
        }
      }
    }
  ]
}
```

**Status Codes:**
- 200: Anomaly analysis completed
- 400: Invalid date range or format
- 429: Rate limit exceeded

### GET /api/analytics/events

Retrieves raw events with optional filtering.

**Query Parameters:**
- `start_date`: ISO8601 timestamp (default: 7 days ago)
- `end_date`: ISO8601 timestamp (default: now)
- `type`: Optional event type filter (issued|attested|revoked|suspended|verified)

**Response:**
```json
{
  "start_date": "2026-06-18T00:00:00Z",
  "end_date": "2026-06-25T00:00:00Z",
  "event_type_filter": "issued",
  "total_events": 1250,
  "events": [
    {
      "type": "issued",
      "credential_id": "cred-123",
      "timestamp": "2026-06-22T14:30:00Z",
      "issuer": "issuer-1",
      "subject": "subject-456"
    }
  ]
}
```

**Status Codes:**
- 200: Events retrieved
- 400: Invalid date range or format
- 429: Rate limit exceeded

### GET /api/analytics/summary

Returns overall analytics summary.

**Response:**
```json
{
  "total_events": 45230,
  "total_days": 365,
  "retention_days": 730,
  "generated_at": "2026-06-25T10:30:00Z"
}
```

### GET /api/analytics/health

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "service": "analytics",
  "timestamp": "2026-06-25T10:30:00Z"
}
```

## Data Models

### CredentialEvent

```typescript
interface CredentialEvent {
  type: 'issued' | 'attested' | 'revoked' | 'suspended' | 'verified';
  credential_id: string;
  timestamp: string;
  issuer?: string;
  subject?: string;
  attestor?: string;
  metadata?: Record<string, unknown>;
}
```

### DailyMetrics

```typescript
interface DailyMetrics {
  date: string;
  issued_count: number;
  attested_count: number;
  revoked_count: number;
  suspended_count: number;
  verified_count: number;
  unique_issuers: number;
  unique_subjects: number;
  unique_attestors: number;
  issuance_rate: number;
  revocation_rate: number;
  attestation_rate: number;
  anomaly_score: number;
}
```

## Metrics Calculation

### Aggregation Process

1. **Event Recording**: Events are recorded in real-time
2. **Hourly Aggregation**: Events are automatically aggregated to hourly buckets
3. **Daily Aggregation**: Hourly metrics are summed to daily metrics
4. **Rate Calculation**: Rates are calculated as event_count / total_events
5. **Anomaly Scoring**: Z-score is calculated against historical data

### Anomaly Detection

Anomaly detection uses Z-score statistical analysis:

- **Z-Score > 2.5**: Flagged as anomalous
- **Expected Range**: Mean ± 3σ (standard deviations)
- **Baseline**: Uses all historical data points before the target date

## Rate Limiting

Rate limiting is applied globally via centralized middleware. All `/api/*` routes are protected.

- **Window**: 60 seconds per window
- **General Limit**: 100 requests per window per client
- **Client Identification**: Uses `X-Stellar-Address` header for authenticated users, falls back to IP address
- **Response Headers**:
  - `X-RateLimit-Limit`: Maximum requests allowed in the window
  - `X-RateLimit-Remaining`: Requests remaining in the current window
  - `X-RateLimit-Reset`: Unix timestamp when the window resets
  - `Retry-After`: Seconds to wait before retrying (when rate limited)
- **Response**: 429 status code with JSON error body when limit exceeded
- **Exponential Backoff**: Repeated violations double the wait time per offense (up to `maxViolations` threshold, after which the client is permanently blocked)
- **DDoS Protection**: Additional layer with request body size limits (100 KB), burst detection (20 requests per 2s window per IP), and concurrent request limits (20 per IP)

## GDPR Compliance

The analytics service implements GDPR compliance by:

1. **Aggregated Data Only**: Metrics are aggregated to prevent individual identification
2. **No PII in Metrics**: Personal identifiers are removed from aggregated views
3. **Retention Policy**: Automatic deletion of events older than configured retention period
4. **Data Minimization**: Only necessary fields are retained

## Data Retention

- **Default Retention**: 730 days (2 years)
- **Cleanup**: Automatic cleanup runs on access
- **Older Events**: Events older than retention period are purged
- **Configuration**: Adjustable via code constant `RETENTION_DAYS`

## Testing

Comprehensive test suite includes:

- Event recording and validation
- Metrics aggregation across time ranges
- Anomaly detection accuracy
- Data integrity validation
- Rate limiting enforcement
- GDPR compliance verification
- Edge case handling
- 10,000+ synthetic event scenarios
- 90-day query window performance

**Run Tests:**
```bash
npm test
```

## Usage Example

### Recording Events

```typescript
import { metricsStore } from './services/metrics';

metricsStore.recordEvent({
  type: 'issued',
  credential_id: 'cred-123',
  timestamp: new Date().toISOString(),
  issuer: 'issuer-1',
  subject: 'subject-1'
});
```

### Querying Metrics

```bash
curl "http://localhost:3000/api/analytics/metrics?start_date=2026-06-22&end_date=2026-06-25"
```

### Detecting Anomalies

```bash
curl "http://localhost:3000/api/analytics/anomalies?start_date=2026-05-23&end_date=2026-06-25"
```

## Performance Considerations

- **In-Memory Storage**: Metrics stored in memory for fast access
- **Aggregation**: Events aggregated at hourly and daily intervals
- **Query Performance**: Sub-millisecond response times for standard queries
- **Scalability**: Efficient memory usage with configurable retention

## Future Enhancements

- Persistent storage backend (database)
- Time-series database integration
- Real-time streaming dashboard
- Machine learning anomaly detection
- Custom alert thresholds
- Webhook notifications
- Export capabilities (CSV, JSON)

## References

- Issue: #655
- Feature: Credential Analytics and Audit Dashboard Backend
