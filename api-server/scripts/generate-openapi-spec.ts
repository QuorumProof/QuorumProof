/**
 * Issue #1309 — Writes the generated OpenAPI 3.1 document to
 * `openapi/openapi.json`.
 *
 * The live server always serves a freshly-built spec from
 * `src/openapi/index.ts` at `/api-docs/openapi.json` — this script exists
 * so there's a static, diffable artifact in source control (useful for
 * import into API clients like Postman, and as the input the TypeScript
 * client generator consumes; see `openapi-ts.config.ts` and the
 * `generate:client` npm script).
 *
 * Run with: npm run openapi:generate
 */
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { buildOpenApiSpec } from '../src/openapi/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '../openapi');
const outFile = join(outDir, 'openapi.json');

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, JSON.stringify(buildOpenApiSpec(), null, 2) + '\n', 'utf-8');

console.log(`Wrote ${outFile}`);
