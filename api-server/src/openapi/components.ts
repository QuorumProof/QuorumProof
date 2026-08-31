/**
 * Issue #1309 — Shared OpenAPI 3.1 components.
 *
 * Schemas here are referenced by `$ref` from the per-resource path
 * definitions in `./paths/*`. A handful (marked below) are imported
 * directly from `middleware/validate.ts` — those are the *actual* AJV
 * JSON Schema objects the server validates requests against, reused
 * as-is so the published spec can never drift from real request
 * validation behaviour.
 */

import type { ComponentsObject, SchemaObject } from 'openapi3-ts/oas31';
import { schemas as validationSchemas } from '../middleware/validate.js';

const errorResponse: SchemaObject = {
  type: 'object',
  properties: {
    error: { type: 'string', description: 'Short, machine-oriented error code or summary.' },
    message: { type: 'string', description: 'Human-readable explanation.' },
  },
  required: ['error'],
};

/**
 * RFC 9457 Problem Details schema (Issue #1428).
 *
 * All v1 routes that have adopted the shared problemJson() formatter return
 * this shape.  v2 routes return this shape exclusively (without the legacy
 * `error` alias being surfaced separately).
 *
 * Content-Type: application/problem+json
 */
const problemDetailsResponse: SchemaObject = {
  type: 'object',
  description:
    'RFC 9457 Problem Details (https://www.rfc-editor.org/rfc/rfc9457). ' +
    'Returned by all endpoints that have adopted the shared error formatter. ' +
    'Content-Type is application/problem+json.',
  properties: {
    type: {
      type: 'string',
      format: 'uri',
      description:
        'Absolute URI that identifies the problem type. ' +
        'Dereferenceable documentation is hosted at the URI.',
      example: 'https://quorumproof.io/errors/not-found',
    },
    title: {
      type: 'string',
      description:
        'Short, human-readable summary of the problem type. ' +
        'Does not change between occurrences of the same problem.',
      example: 'Not Found',
    },
    status: {
      type: 'integer',
      description: 'HTTP status code, mirrored from the response status.',
      example: 404,
    },
    detail: {
      type: 'string',
      description: 'Human-readable explanation specific to this occurrence of the problem.',
      example: 'Recovery request not found',
    },
    error: {
      type: 'string',
      description:
        'Backward-compatible alias for `detail`. ' +
        'Present on all v1 responses so existing clients that read `body.error` continue to work.',
      example: 'Recovery request not found',
    },
    instance: {
      type: 'string',
      format: 'uri',
      description:
        'Optional URI that identifies this specific occurrence of the problem. ' +
        'May point to a support ticket or log trace.',
    },
  },
  required: ['type', 'title', 'status', 'detail', 'error'],
};

const validationErrorResponse: SchemaObject = {
  type: 'object',
  properties: {
    error: { type: 'string', example: 'Validation failed' },
    details: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          keyword: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
  },
  required: ['error'],
};

const pagination: SchemaObject = {
  type: 'object',
  properties: {
    total: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1 },
    offset: { type: 'integer', minimum: 0 },
    next_cursor: { type: ['string', 'null'] },
  },
};

export const components: ComponentsObject = {
  securitySchemes: {
    bearerAuth: {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description:
        'Session access token issued by /auth/login or /auth/passwordless/verify. ' +
        'Sent as `Authorization: Bearer <token>`. Required for account/session/MFA endpoints.',
    },
    apiKeyAuth: {
      type: 'apiKey',
      in: 'header',
      name: 'x-api-key',
      description:
        'Long-lived API key issued via /api/api-keys. Subject to per-key rate limiting ' +
        'independent of the general IP-based limiter.',
    },
  },
  schemas: {
    ErrorResponse: errorResponse,
    ProblemDetailsResponse: problemDetailsResponse,
    ValidationErrorResponse: validationErrorResponse,
    Pagination: pagination,

    // Reused verbatim from the AJV validators that actually run at request
    // time — see middleware/validate.ts. Keeping a single source of truth
    // means the documented request shape can never silently diverge from
    // the enforced one.
    VerifyBatchRequest: validationSchemas.verifyBatch.body as SchemaObject,
    VerifyBatchClaimsRequest: validationSchemas.verifyBatchClaims.body as SchemaObject,
    NotificationPreferencesRequest: validationSchemas.notificationPreferences.body as SchemaObject,
    NotificationSendRequest: validationSchemas.notificationSend.body as SchemaObject,
    AnalyticsEventRequest: validationSchemas.analyticsEvent.body as SchemaObject,
    AuditVerifyRequest: validationSchemas.auditVerify.body as SchemaObject,

    HealthStatus: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['healthy', 'degraded', 'unhealthy'] },
        checks: { type: 'object', additionalProperties: true },
        timestamp: { type: 'string', format: 'date-time' },
      },
      required: ['status'],
    },

    BatchVerificationResult: {
      type: 'object',
      properties: {
        credential_id: { type: 'integer' },
        claim_type: { type: 'string' },
        status: {
          type: 'string',
          enum: ['verified', 'failed', 'not_found', 'revoked', 'expired', 'error'],
        },
        proof: {
          type: ['object', 'null'],
          properties: {
            verified_at: { type: 'string', format: 'date-time' },
            credential_status: {
              type: 'string',
              enum: ['active', 'revoked', 'suspended', 'expired'],
            },
            digest: { type: 'string', description: '16-hex-char stable digest.' },
          },
        },
        error: { type: ['string', 'null'] },
      },
      required: ['credential_id', 'claim_type', 'status'],
    },

    BatchVerificationResponse: {
      type: 'object',
      properties: {
        results: { type: 'array', items: { $ref: '#/components/schemas/BatchVerificationResult' } },
        summary: {
          type: 'object',
          properties: {
            total: { type: 'integer' },
            verified: { type: 'integer' },
            failed: { type: 'integer' },
            not_found: { type: 'integer' },
            errors: { type: 'integer' },
            duplicates_deduplicated: { type: 'integer' },
            execution_time_ms: { type: 'number' },
          },
        },
      },
    },

    Credential: {
      type: 'object',
      description: 'A credential as returned by the search index / dashboard endpoints.',
      properties: {
        id: { type: 'integer' },
        claim_type: { type: 'string' },
        issuer: { type: 'string', description: 'Stellar address of the issuer.' },
        holder: { type: 'string', description: 'Stellar address of the holder.' },
        status: { type: 'string', enum: ['active', 'revoked', 'suspended', 'expired'] },
        metadata_hash: { type: 'string' },
        issued_at: { type: 'string', format: 'date-time' },
      },
      required: ['id', 'claim_type', 'issuer', 'holder', 'status'],
    },

    Slice: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        name: { type: 'string' },
        credential_ids: { type: 'array', items: { type: 'integer' } },
        created_at: { type: 'string', format: 'date-time' },
      },
      required: ['id'],
    },

    ApiKey: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        prefix: { type: 'string', description: 'Non-secret prefix used to identify the key in listings.' },
        created_at: { type: 'string', format: 'date-time' },
        last_used_at: { type: ['string', 'null'], format: 'date-time' },
        revoked: { type: 'boolean' },
      },
      required: ['id', 'prefix'],
    },

    ApiKeyCreateResponse: {
      allOf: [
        { $ref: '#/components/schemas/ApiKey' },
        {
          type: 'object',
          properties: {
            secret: {
              type: 'string',
              description: 'Full secret key — returned exactly once, at creation time. Not recoverable afterward.',
            },
          },
          required: ['secret'],
        },
      ],
    },

    Webhook: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        url: { type: 'string', format: 'uri' },
        events: { type: 'array', items: { type: 'string' } },
        created_at: { type: 'string', format: 'date-time' },
      },
      required: ['id', 'url', 'events'],
    },

    AttestorStatus: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        address: { type: 'string' },
        reputation: { type: 'number' },
        online: { type: 'boolean' },
        last_seen: { type: ['string', 'null'], format: 'date-time' },
      },
      required: ['id', 'address'],
    },

    GdprRequest: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        type: { type: 'string', enum: ['erasure', 'access', 'rectification'] },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'rejected'] },
        created_at: { type: 'string', format: 'date-time' },
      },
      required: ['request_id', 'type', 'status'],
    },

    // ── v2-only shapes (Issue #1427) ─────────────────────────────────────────

    /**
     * v2 pagination envelope.
     * Uses `cursor` (opaque base64 token) instead of v1's `next_cursor`.
     */
    V2Pagination: {
      type: 'object',
      description: 'v2 pagination wrapper. Uses `cursor` instead of `next_cursor`.',
      properties: {
        items: { type: 'array', items: {} },
        total: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1 },
        cursor: {
          type: ['string', 'null'],
          description: 'Opaque base64-encoded cursor for the next page. Null when on the last page.',
        },
      },
      required: ['items', 'total', 'limit', 'cursor'],
    },

    /**
     * v2 Proof-Request resource.
     * Managed ZK proof-request lifecycle: /api/v2/proof-requests.
     */
    V2ProofRequest: {
      type: 'object',
      description: 'A managed ZK proof-request (v2 only).',
      properties: {
        id: { type: 'string' },
        credential_id: { type: 'integer' },
        claim_type: { type: 'string' },
        requester: { type: 'string', description: 'Stellar address of the verifier.' },
        created_at: { type: 'string', format: 'date-time' },
        expires_at: { type: 'string', format: 'date-time' },
        status: { type: 'string', enum: ['pending', 'fulfilled', 'expired', 'cancelled'] },
        proof: { type: ['string', 'null'], description: 'Base64-encoded opaque proof blob when fulfilled.' },
      },
      required: ['id', 'credential_id', 'claim_type', 'requester', 'created_at', 'expires_at', 'status'],
    },

    /**
     * v2 Revocation-Registry entry.
     * Batch revocation with optional time-locks: /api/v2/revocation-registry.
     */
    V2RevocationEntry: {
      type: 'object',
      description: 'An entry in the v2 revocation registry.',
      properties: {
        credential_id: { type: 'integer' },
        revoked_by: { type: 'string', description: 'Stellar address of the revoker.' },
        reason: { type: ['string', 'null'] },
        revoked_at: { type: 'string', format: 'date-time' },
        locked_until: {
          type: ['string', 'null'],
          format: 'date-time',
          description: 'If set, the entry cannot be removed before this timestamp.',
        },
        revoked: { type: 'boolean', description: 'Always true for entries in the registry.' },
      },
      required: ['credential_id', 'revoked_by', 'revoked_at', 'revoked'],
    },

    /**
     * v2 BBS+ Credential resource.
     * Selective-disclosure credentials: /api/v2/bbs-credentials.
     *
     * v2 field renames vs v1:
     *   `address`  → `stellar_address`
     *   `metadata` → `metadata_hash`
     */
    V2BbsCredential: {
      type: 'object',
      description: 'A BBS+ selective-disclosure credential (v2 only).',
      properties: {
        id: { type: 'string' },
        stellar_address: {
          type: 'string',
          description: 'Stellar address of the credential holder. Renamed from `address` in v1.',
        },
        claim_type: { type: 'string' },
        metadata_hash: {
          type: 'string',
          description: 'SHA-256 hash of the credential metadata. Renamed from `metadata` in v1.',
        },
        issued_at: { type: 'string', format: 'date-time' },
        issuer_key: { type: 'string', description: 'BBS+ public key of the issuer.' },
        status: { type: 'string', enum: ['active', 'revoked'] },
        signature: { type: 'string', description: 'Base64-encoded BBS+ signature.' },
      },
      required: ['id', 'stellar_address', 'claim_type', 'metadata_hash', 'issued_at', 'issuer_key', 'status'],
    },

    /**
     * v2 BBS+ Selective-Disclosure Presentation.
     */
    V2BbsPresentation: {
      type: 'object',
      description: 'A BBS+ selective-disclosure presentation derived from a V2BbsCredential.',
      properties: {
        credential_id: { type: 'string' },
        stellar_address: { type: 'string' },
        claim_type: { type: 'string' },
        disclosed_attributes: { type: 'array', items: { type: 'string' } },
        presentation_proof: { type: 'string', description: 'Base64-encoded BBS+ presentation proof.' },
        created_at: { type: 'string', format: 'date-time' },
      },
      required: ['credential_id', 'stellar_address', 'claim_type', 'disclosed_attributes', 'presentation_proof', 'created_at'],
    },
  },
};

export const tags = [
  { name: 'Health', description: 'Liveness / readiness probes and service status.' },
  { name: 'Verification', description: 'Credential and batch claim verification.' },
  { name: 'Credentials', description: 'Credential search, metadata, revocation list, sharded storage stats.' },
  { name: 'Slices', description: 'Credential slice (batch) lookups.' },
  { name: 'Attestors', description: 'Attestor directory, availability and reputation.' },
  { name: 'Issuer', description: 'Per-issuer metrics and analytics.' },
  { name: 'Analytics', description: 'Platform-wide event ingestion and derived metrics.' },
  { name: 'Dashboard', description: 'Credential-holder dashboard (my credentials, disputes, access log).' },
  { name: 'Notifications', description: 'Notification preferences and delivery.' },
  { name: 'Webhooks', description: 'Outbound event webhook subscriptions and delivery logs.' },
  { name: 'GDPR', description: 'Data subject access / erasure requests, consent records.' },
  { name: 'Consent', description: 'Per-credential verifier consent grants.' },
  { name: 'Share Links', description: 'Time-limited shareable credential links.' },
  { name: 'API Keys', description: 'API key issuance, rotation and usage.' },
  { name: 'OAuth2', description: 'OAuth2 / OIDC identity provider linking.' },
  { name: 'Auth', description: 'Session login, MFA, and passwordless / WebAuthn auth.' },
  { name: 'Recovery', description: 'Account recovery via OTP.' },
  { name: 'Privilege Escalation', description: 'Step-up MFA approval workflow for privileged actions.' },
  { name: 'Audit', description: 'Immutable audit log entries and batch notarization.' },
  { name: 'Reports', description: 'Compliance, cost, usage and expiry-forecast reports.' },
  { name: 'Costs', description: 'Infrastructure cost reporting and optimization suggestions.' },
  { name: 'Bridge', description: 'Cross-chain credential anchoring and light-client sync.' },
  { name: 'Tracing', description: 'Distributed trace lookup.' },
  { name: 'GraphQL', description: 'GraphQL endpoint (alternative to the REST surface).' },
  { name: 'Metrics', description: 'Prometheus-format and JSON operational metrics.' },
  // v2-only tags (Issue #1427)
  { name: 'v2 Proof Requests', description: 'Managed ZK proof-request lifecycle (v2 only).' },
  { name: 'v2 Revocation Registry', description: 'Batch revocation with optional time-locks (v2 only).' },
  { name: 'v2 BBS+ Credentials', description: 'BBS+ selective-disclosure credentials (v2 only).' },
];
