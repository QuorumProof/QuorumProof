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
];
