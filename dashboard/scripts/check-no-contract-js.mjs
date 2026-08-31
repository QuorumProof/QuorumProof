#!/usr/bin/env node
/**
 * check-no-contract-js.mjs
 *
 * Fails with exit code 1 if any *.js files exist under
 * dashboard/src/lib/contracts/. These are stale build artefacts that were
 * removed in #1461. The TypeScript sources are the single source of truth;
 * compiled output lives in dist/, not in src/.
 *
 * Run via: npm run lint:no-contract-js
 * Also wired into CI in the dashboard job.
 */

import { readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const contractsDir = join(__dirname, '..', 'src', 'lib', 'contracts')

let jsFiles
try {
  jsFiles = readdirSync(contractsDir).filter((f) => f.endsWith('.js'))
} catch {
  // Directory doesn't exist — nothing to check
  process.exit(0)
}

if (jsFiles.length > 0) {
  console.error(
    `\n[check-no-contract-js] ERROR: Found .js files in src/lib/contracts/:\n` +
    jsFiles.map((f) => `  • ${f}`).join('\n') +
    `\n\nThese are stale build artefacts. Remove them and do not commit compiled` +
    ` output into src/.\nSee issue #1461 for context.\n`
  )
  process.exit(1)
}

console.log('[check-no-contract-js] OK — no .js files found in src/lib/contracts/')
