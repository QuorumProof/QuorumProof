import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  applyFieldFilter,
  CREDENTIAL_FIELD_SCHEMA,
  fieldSelection,
  parseFieldsParam,
  resolveAllowedFields,
} from '../src/middleware/fieldSelection.js';

describe('field selection', () => {
  it('parses comma-separated fields and treats absent or empty values as no selection', () => {
    expect(parseFieldsParam(undefined)).toBeNull();
    expect(parseFieldsParam(' , ')).toBeNull();
    expect(parseFieldsParam(' id, status, id ')).toEqual(new Set(['id', 'status']));
    expect(parseFieldsParam(['id', 'status'])).toBeNull();
  });

  it('always allows required fields but drops unknown and internal fields', () => {
    expect(resolveAllowedFields(
      new Set(['status', 'metadata_hash', '_internal_raw', 'not_a_field']),
      CREDENTIAL_FIELD_SCHEMA,
    )).toEqual(new Set(['id', 'status', 'metadata_hash']));
  });

  it('preserves complete responses when unconfigured and strips schema internal fields', () => {
    const body = { id: 'cred-1', status: 'active', _internal_raw: 'private' };

    expect(applyFieldFilter(body, null)).toBe(body);
    expect(applyFieldFilter(body, null, CREDENTIAL_FIELD_SCHEMA))
      .toEqual({ id: 'cred-1', status: 'active' });
  });

  it('filters requested fields from bare objects and results envelopes', async () => {
    const app = express();
    app.get(
      '/credentials',
      fieldSelection({ schema: CREDENTIAL_FIELD_SCHEMA }),
      (_req, res) => res.json({
        results: [
          { id: 'cred-1', status: 'active', subject: 'GABC', _internal_raw: 'secret' },
          { id: 'cred-2', status: 'revoked', subject: 'GDEF', _internal_raw: 'secret' },
        ],
      }),
    );
    app.get(
      '/credential',
      fieldSelection({ schema: CREDENTIAL_FIELD_SCHEMA }),
      (_req, res) => res.json({
        id: 'cred-1',
        status: 'active',
        subject: 'GABC',
        _internal_raw: 'secret',
      }),
    );

    const envelope = await request(app).get('/credentials?fields=status,unknown,_internal_raw');
    expect(envelope.status).toBe(200);
    expect(envelope.body.results).toEqual([
      { id: 'cred-1', status: 'active' },
      { id: 'cred-2', status: 'revoked' },
    ]);

    const bare = await request(app).get('/credential?fields=subject');
    expect(bare.body).toEqual({ id: 'cred-1', subject: 'GABC' });
  });

  it('returns a 400 for unknown fields in strict mode without invoking the route', async () => {
    const app = express();
    app.get(
      '/credentials',
      fieldSelection({ schema: CREDENTIAL_FIELD_SCHEMA, strictValidation: true }),
      (_req, res) => res.json({ id: 'should-not-run' }),
    );

    const response = await request(app).get('/credentials?fields=status,missing');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: 'Unknown fields requested',
      unknown_fields: ['missing'],
    });
    expect(response.body.available_fields).not.toContain('_internal_raw');
  });
});
