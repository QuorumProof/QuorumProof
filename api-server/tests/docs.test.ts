/**
 * Tests for Issue #1309 — OpenAPI 3.1 generation, Swagger UI, and ReDoc.
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildOpenApiSpec } from '../src/openapi/index.js';
import docsRouter from '../src/routes/docs.js';

function makeApp() {
  const app = express();
  app.use('/api-docs', docsRouter);
  return app;
}

describe('buildOpenApiSpec', () => {
  const spec = buildOpenApiSpec();

  it('declares OpenAPI 3.1', () => {
    expect(spec.openapi).toBe('3.1.0');
  });

  it('has info.title and info.version', () => {
    expect(spec.info.title).toBe('QuorumProof API');
    expect(typeof spec.info.version).toBe('string');
    expect(spec.info.version.length).toBeGreaterThan(0);
  });

  it('declares bearer and apiKey security schemes', () => {
    expect(spec.components?.securitySchemes?.bearerAuth).toBeDefined();
    expect(spec.components?.securitySchemes?.apiKeyAuth).toBeDefined();
  });

  it('documents a substantial number of operations', () => {
    const paths = spec.paths ?? {};
    let operationCount = 0;
    for (const item of Object.values(paths)) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
        if (item[method]) operationCount++;
      }
    }
    expect(Object.keys(paths).length).toBeGreaterThan(50);
    expect(operationCount).toBeGreaterThan(50);
  });

  it('includes the batch verification endpoint reusing the AJV validation schema', () => {
    const op = spec.paths?.['/api/verify/batch']?.post;
    expect(op).toBeDefined();
    const schema =
      op?.requestBody &&
      'content' in op.requestBody
        ? op.requestBody.content['application/json']?.schema
        : undefined;
    expect(schema).toEqual({ $ref: '#/components/schemas/VerifyBatchClaimsRequest' });
  });

  it('re-mounts the api-keys paths under /auth/api-keys as well as /api/api-keys', () => {
    expect(spec.paths?.['/api/api-keys']).toBeDefined();
    expect(spec.paths?.['/auth/api-keys']).toBeDefined();
    expect(spec.paths?.['/api/api-keys/{id}/rotate']).toBeDefined();
    expect(spec.paths?.['/auth/api-keys/{id}/rotate']).toBeDefined();
  });

  it('every $ref in the document resolves to an existing component', () => {
    const refs: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node && typeof node === 'object') {
        const obj = node as Record<string, unknown>;
        if (typeof obj.$ref === 'string') refs.push(obj.$ref);
        Object.values(obj).forEach(walk);
      }
    };
    walk(spec);

    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith('#/')).toBe(true);
      const parts = ref.slice(2).split('/');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let node: any = spec;
      for (const part of parts) {
        expect(node && typeof node === 'object' && part in node).toBe(true);
        node = node[part];
      }
    }
  });

  it('does not document routers that are not actually mounted in index.ts', () => {
    // #925/#1301 audit routers, and the auth / passwordless-auth / bridge /
    // graphql / reports / costs / verification routers, exist in the
    // codebase but are never app.use()'d in src/index.ts — only exercised
    // directly by their own unit tests. Documenting them would describe
    // endpoints that 404 on the real server.
    const paths = Object.keys(spec.paths ?? {});
    expect(paths.some((p) => p.startsWith('/api/audit'))).toBe(false);
    expect(paths.some((p) => p.startsWith('/api/bridge'))).toBe(false);
    expect(paths.some((p) => p.startsWith('/api/reports'))).toBe(false);
    expect(paths.some((p) => p.startsWith('/api/costs'))).toBe(false);
    expect(paths.some((p) => p.startsWith('/api/graphql'))).toBe(false);
  });
});

describe('GET /api-docs/openapi.json', () => {
  it('serves the generated spec as JSON', async () => {
    const res = await request(makeApp()).get('/api-docs/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.paths).toBeDefined();
  });
});

describe('GET /api-docs/ (Swagger UI)', () => {
  it('serves the Swagger UI HTML shell', async () => {
    const res = await request(makeApp()).get('/api-docs/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('swagger-ui');
  });
});

describe('GET /api-docs/redoc', () => {
  it('serves the ReDoc HTML shell pointing at the JSON spec', async () => {
    const res = await request(makeApp()).get('/api-docs/redoc');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('<redoc');
    expect(res.text).toContain('openapi.json');
  });
});
