/**
 * Issue #1309 — API documentation endpoints.
 *
 *   GET /api-docs/openapi.json  — the generated OpenAPI 3.1 document
 *   GET /api-docs/              — Swagger UI (interactive, "try it out")
 *   GET /api-docs/redoc         — ReDoc (three-pane reference viewer)
 *
 * The spec is (re)built on every request to openapi.json instead of being
 * read from a static file, so it always reflects the definitions currently
 * in `../openapi/paths/*` — see `../openapi/index.ts`.
 */

import { Router, Request, Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApiSpec } from '../openapi/index.js';

const router = Router();

router.get('/openapi.json', (_req: Request, res: Response) => {
  res.json(buildOpenApiSpec());
});

router.use('/', swaggerUi.serve);
router.get('/', swaggerUi.setup(undefined, {
  swaggerOptions: { url: 'openapi.json' },
  customSiteTitle: 'QuorumProof API — Swagger UI',
}));

router.get('/redoc', (_req: Request, res: Response) => {
  res.type('html').send(`<!DOCTYPE html>
<html>
  <head>
    <title>QuorumProof API — ReDoc</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>body { margin: 0; padding: 0; }</style>
  </head>
  <body>
    <redoc spec-url="./openapi.json"></redoc>
    <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
  </body>
</html>`);
});

export default router;
