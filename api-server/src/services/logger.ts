/**
 * #586 — Structured file-based logging via pino.
 *
 * Log destination:
 *   - LOG_FILE env var (default: /var/log/quorumproof/api.log) — always written
 *   - stdout — also written unless LOG_STDOUT=false
 *
 * This dual-destination ensures:
 *   • promtail can ship logs to Loki by tailing the log file
 *   • Developers running the server locally still see output in the terminal
 *
 * Log level is controlled by LOG_LEVEL (default: info).
 * Module-specific levels: MODULE_LOGS=auth:debug,webhook:warn
 *
 * The log file's parent directory is created at startup if it does not exist.
 */

import pino from 'pino';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_FILE = process.env.LOG_FILE ?? '/var/log/quorumproof/api.log';
const LOG_LEVEL = (process.env.LOG_LEVEL ?? 'info') as pino.Level;
const LOG_STDOUT = process.env.LOG_STDOUT !== 'false';

let canWriteFile = true;
// Ensure the log directory exists before we try to open the file.
try {
  mkdirSync(dirname(LOG_FILE), { recursive: true });
} catch {
  // If we cannot create the directory (e.g. permission denied in unit tests)
  // we fall back gracefully to stdout-only logging below.
  canWriteFile = false;
}

// Build the pino transport destinations.
// pino.multistream lets us write to multiple sinks simultaneously.
function buildStreams(): pino.MultiStreamRes {
  const targets: pino.StreamEntry[] = [];

  if (LOG_STDOUT) {
    targets.push({
      stream: process.stdout,
      level: LOG_LEVEL,
    });
  }

  // File transport — this is what promtail scrapes.
  if (canWriteFile) {
    try {
      const fileTransport = pino.destination({
        dest: LOG_FILE,
        sync: false, // async I/O — non-blocking
      });
      fileTransport.on('error', () => {
        // Suppress unhandled stream error in restricted environments
      });
      targets.push({ stream: fileTransport, level: LOG_LEVEL });
    } catch (err) {
      // If we cannot open the file (e.g. restricted permissions in CI) we
      // continue with stdout-only so tests do not fail due to logging.
      if (LOG_STDOUT) {
        process.stderr.write(
          `[logger] Warning: cannot open ${LOG_FILE}: ${String(err)}. Falling back to stdout only.\n`,
        );
      }
    }
  }

  return pino.multistream(targets);
}

const pinoLogger = pino(
  {
    level: LOG_LEVEL,
    base: { service: 'quorumproof-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  },
  buildStreams(),
);

// ---------------------------------------------------------------------------
// Module-specific overrides (MODULE_LOGS=auth:debug,webhook:warn)
// ---------------------------------------------------------------------------
const moduleLevels = new Map<string, pino.Level>();
const rawModuleLogs = process.env.MODULE_LOGS;
if (rawModuleLogs) {
  for (const item of rawModuleLogs.split(',')) {
    const [mod, level] = item.trim().split(':');
    if (mod && level) {
      moduleLevels.set(mod, level as pino.Level);
    }
  }
}

function childFor(module?: string): pino.Logger {
  const child = module ? pinoLogger.child({ module }) : pinoLogger;
  if (module && moduleLevels.has(module)) {
    // pino children inherit parent level; override with module-specific level
    return child.child({}, { level: moduleLevels.get(module) });
  }
  return child;
}

// ---------------------------------------------------------------------------
// Public API — mirrors the original StructuredLogger interface so all call
// sites continue to work without modification.
// ---------------------------------------------------------------------------

class StructuredLogger {
  constructor(private readonly _service = 'quorumproof-api') {}

  debug(message: string, module?: string, metadata?: Record<string, unknown>): void {
    childFor(module).debug({ ...metadata }, message);
  }

  info(message: string, module?: string, metadata?: Record<string, unknown>): void {
    childFor(module).info({ ...metadata }, message);
  }

  warn(message: string, module?: string, metadata?: Record<string, unknown>): void {
    childFor(module).warn({ ...metadata }, message);
  }

  error(message: string, module?: string, metadata?: Record<string, unknown>): void {
    childFor(module).error({ ...metadata }, message);
  }

  /** Runtime log-level override (affects the root pino instance). */
  setLogLevel(level: LogLevel): void {
    pinoLogger.level = level;
  }

  setModuleLogLevel(module: string, level: LogLevel): void {
    moduleLevels.set(module, level as pino.Level);
  }

  getLogLevel(): LogLevel {
    return pinoLogger.level as LogLevel;
  }

  getModuleLogLevel(module: string): LogLevel | undefined {
    return moduleLevels.get(module) as LogLevel | undefined;
  }
}

const logger = new StructuredLogger();

export { logger, StructuredLogger };
