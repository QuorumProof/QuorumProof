import { Request, Response, NextFunction } from 'express';
import { default as AjvLib } from 'ajv';

const Ajv = AjvLib as unknown as new (opts: Record<string, unknown>) => {
  compile: (schema: Record<string, unknown>) => (data: unknown) => boolean;
};
const ajv = new Ajv({ coerceTypes: true, useDefaults: true, removeAdditional: true });

type ValidationSchemas = {
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
};

interface AjvValidator {
  (data: unknown): boolean;
  errors?: Array<{ schemaPath: string; keyword: string; message: string; data: unknown }>;
}

export function validate(schemas: ValidationSchemas) {
  const validators: {
    check: (data: unknown) => boolean;
    location: string;
    validator: AjvValidator;
  }[] = [];

  if (schemas.body) {
    const validateBody = ajv.compile(schemas.body) as AjvValidator;
    validators.push({ check: (d) => validateBody(d), location: 'body', validator: validateBody });
  }
  if (schemas.query) {
    const validateQuery = ajv.compile(schemas.query) as AjvValidator;
    validators.push({ check: (d) => validateQuery(d), location: 'query', validator: validateQuery });
  }
  if (schemas.params) {
    const validateParams = ajv.compile(schemas.params) as AjvValidator;
    validators.push({ check: (d) => validateParams(d), location: 'params', validator: validateParams });
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    for (const v of validators) {
      let data: unknown;
      if (v.location === 'body') data = req.body;
      else if (v.location === 'query') data = req.query;
      else if (v.location === 'params') data = req.params;

      if (!v.check(data)) {
        // Issue #1312: Include detailed error information for debugging.
        const errors = v.validator.errors ?? [];
        res.status(400).json({
          error: 'Validation failed',
          location: v.location,
          details: errors.map((err) => ({
            path: err.schemaPath,
            keyword: err.keyword,
            message: err.message,
            instance: err.data,
          })),
        });
        return;
      }
    }
    next();
  };
}

export const schemas = {
  verifyBatch: {
    body: {
      type: 'object',
      properties: {
        credential_ids: {
          type: 'array',
          items: { type: 'integer', minimum: 1 },
          minItems: 1,
          maxItems: 50,
        },
        slice_id: { type: 'integer', minimum: 1 },
      },
      required: ['credential_ids', 'slice_id'],
      additionalProperties: false,
    },
  },

  verifyBatchClaims: {
    body: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              credential_id: { type: 'integer', minimum: 1 },
              claim_type: { type: 'string', minLength: 1, maxLength: 64 },
            },
            required: ['credential_id', 'claim_type'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
  },

  notificationPreferences: {
    body: {
      type: 'object',
      properties: {
        address: { type: 'string', minLength: 1 },
        email: { type: 'string' },
        phone: { type: 'string' },
        channels: {
          type: 'array',
          items: { type: 'string', enum: ['email', 'sms'] },
          minItems: 1,
        },
        events: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'credential_issued', 'credential_revoked', 'credential_suspended',
              'credential_attested', 'credential_expiring',
            ],
          },
          minItems: 1,
        },
        /** #928: optional per-type filter; 1=Degree, 2=License, 3=Employment */
        credential_type_filters: {
          type: 'array',
          items: { type: 'integer', minimum: 1 },
        },
        enabled: { type: 'boolean' },
      },
      required: ['address', 'channels', 'events'],
      additionalProperties: false,
    },
  },

  notificationSend: {
    body: {
      type: 'object',
      properties: {
        address: { type: 'string', minLength: 1 },
        event: {
          type: 'string',
          enum: [
            'credential_issued', 'credential_revoked', 'credential_suspended',
            'credential_attested', 'credential_expiring',
          ],
        },
        credential_id: { type: 'integer', minimum: 1 },
        /** #928: optional credential type for per-type preference filtering */
        credential_type: { type: 'integer', minimum: 1 },
        issuer: { type: 'string' },
        holder: { type: 'string' },
      },
      required: ['address', 'event', 'credential_id'],
      additionalProperties: false,
    },
  },

  analyticsEvent: {
    body: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['issued', 'attested', 'revoked', 'suspended', 'verified'],
        },
        credential_id: { type: 'string', minLength: 1 },
        timestamp: { type: 'string', minLength: 1 },
        issuer: { type: 'string' },
        subject: { type: 'string' },
        attestor: { type: 'string' },
      },
      required: ['type', 'credential_id', 'timestamp'],
      additionalProperties: false,
    },
  },

  auditVerify: {
    body: {
      type: 'object',
      properties: {
        batch_id: { type: 'integer', minimum: 1 },
      },
      required: ['batch_id'],
      additionalProperties: false,
    },
  },
};

export default validate;
