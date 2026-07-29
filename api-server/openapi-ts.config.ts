/**
 * Issue #1309 — Config for `@hey-api/openapi-ts`, which generates the
 * TypeScript client library in `generated/client` from `openapi/openapi.json`.
 *
 * Run `npm run generate:client` (regenerates the spec first, then the
 * client) after changing anything under `src/openapi/`.
 */
import { defineConfig } from '@hey-api/openapi-ts';

export default defineConfig({
  input: './openapi/openapi.json',
  output: './generated/client',
  plugins: ['@hey-api/typescript', '@hey-api/sdk', '@hey-api/client-fetch'],
});
