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

export function validate(schemas: ValidationSchemas) {
  const validators: { check: (data: unknown) => boolean; location: string }[] = [];

  if (schemas.body) {
    const validateBody = ajv.compile(schemas.body);
    validators.push({ check: (d) => validateBody(d), location: 'body' });
  }
  if (schemas.query) {
    const validateQuery = ajv.compile(schemas.query);
    validators.push({ check: (d) => validateQuery(d), location: 'query' });
  }
  if (schemas.params) {
    const validateParams = ajv.compile(schemas.params);
    validators.push({ check: (d) => validateParams(d), location: 'params' });
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    for (const v of validators) {
      let data: unknown;
      if (v.location === 'body') data = req.body;
      else if (v.location === 'query') data = req.query;
      else if (v.location === 'params') data = req.params;

      if (!v.check(data)) {
        res.status(400).json({
          error: 'Validation failed',
          location: v.location,
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
