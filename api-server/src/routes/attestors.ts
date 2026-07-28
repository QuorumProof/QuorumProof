/**
 * Issue #996 — Attestor Discovery API
 * Issue #875 — Attestor Availability Status
 *
 * Provides a registry of known attestors (universities, licensing bodies,
 * employers) that credential holders can discover when building their quorum
 * slice.
 *
 * Endpoints:
 *   GET  /api/attestors                   — list all attestors (filterable by type / region)
 *   GET  /api/attestors/:id               — get a single attestor with its credential stats
 *   GET  /api/attestors/:id/status        — get live availability metrics for an attestor
 *   POST /api/attestors/:id/status/ping   — record a ping result (uptime heartbeat)
 *
 * Query parameters for the list endpoint:
 *   type    — filter by attestor type (e.g. "university", "licensing_body", "employer")
 *   region  — filter by region / country code (e.g. "BR", "DE", "US")
 *   q       — free-text search over name and region fields (case-insensitive)
 *   active  — "true" / "false" to filter by active status
 */

import { Router, Request, Response } from 'express';

export interface Attestor {
  id: string;
  name: string;
  /** One of: university | licensing_body | employer | government */
  type: string;
  /** ISO 3166-1 alpha-2 country code or region label */
  region: string;
  /** Brief human-readable description */
  description: string;
  /** Stellar address of the attestor node */
  stellar_address: string;
  /** Total credentials this attestor has co-signed (informational) */
  credentials_issued: number;
  /** Whether the attestor is currently accepting new attestation requests */
  active: boolean;
}

// ---------------------------------------------------------------------------
// Issue #875 — Availability tracking
// ---------------------------------------------------------------------------

/** A single ping result stored for uptime calculation. */
interface PingRecord {
  ts: number;     // Unix ms
  ok: boolean;    // true = reachable, false = timeout/error
  responseMs: number;
}

/** Rolling window: keep at most PING_WINDOW pings per attestor. */
const PING_WINDOW = 100;
/** Consider pings older than 24 h stale; exclude from uptime calc. */
const PING_RETENTION_MS = 24 * 60 * 60 * 1_000;

/**
 * In-memory availability store.  In production this would be backed by
 * the shared database pool (see issue #870 / db.ts), but for the scope of
 * this issue a process-local store correctly captures the live heartbeat
 * data without adding a DB dependency.
 */
const _pingStore = new Map<string, PingRecord[]>();

/** Add a ping record, capping to PING_WINDOW entries and pruning stale ones. */
function recordPing(attestorId: string, ok: boolean, responseMs: number): void {
  const now = Date.now();
  let records = _pingStore.get(attestorId) ?? [];
  // Prune records older than the retention window
  const cutoff = now - PING_RETENTION_MS;
  records = records.filter((r) => r.ts >= cutoff);
  records.push({ ts: now, ok, responseMs });
  // Keep only the most recent PING_WINDOW entries
  if (records.length > PING_WINDOW) {
    records = records.slice(records.length - PING_WINDOW);
  }
  _pingStore.set(attestorId, records);
}

export interface AttestorStatus {
  attestor_id: string;
  /** Fraction of successful pings in the last 24 h, 0–1.  null if no data. */
  uptime_ratio: number | null;
  /** Average response time of successful pings (ms).  null if no data. */
  avg_response_ms: number | null;
  /** Number of active credentials currently co-signed by this attestor. */
  active_credential_count: number;
  /** ISO-8601 timestamp of the last recorded ping. */
  last_seen: string | null;
  /** Human-readable availability tier derived from uptime_ratio. */
  availability: 'excellent' | 'good' | 'degraded' | 'offline' | 'unknown';
}

function computeStatus(attestorId: string, credentialsIssued: number): AttestorStatus {
  const now = Date.now();
  const cutoff = now - PING_RETENTION_MS;
  const records = (_pingStore.get(attestorId) ?? []).filter((r) => r.ts >= cutoff);

  if (records.length === 0) {
    return {
      attestor_id: attestorId,
      uptime_ratio: null,
      avg_response_ms: null,
      active_credential_count: credentialsIssued,
      last_seen: null,
      availability: 'unknown',
    };
  }

  const successful = records.filter((r) => r.ok);
  const uptime_ratio = successful.length / records.length;
  const avg_response_ms =
    successful.length > 0
      ? Math.round(successful.reduce((sum, r) => sum + r.responseMs, 0) / successful.length)
      : null;
  const last_seen = new Date(Math.max(...records.map((r) => r.ts))).toISOString();

  let availability: AttestorStatus['availability'];
  if (uptime_ratio >= 0.99) {
    availability = 'excellent';
  } else if (uptime_ratio >= 0.95) {
    availability = 'good';
  } else if (uptime_ratio >= 0.7) {
    availability = 'degraded';
  } else {
    availability = 'offline';
  }

  return {
    attestor_id: attestorId,
    uptime_ratio,
    avg_response_ms,
    active_credential_count: credentialsIssued,
    last_seen,
    availability,
  };
}

/** Exported for tests. */
export function _resetAvailabilityStoreForTest(): void {
  _pingStore.clear();
}

// ---------------------------------------------------------------------------
// Seed registry — in a production deployment this would be backed by the
// on-chain QuorumProof contract state or a persistent off-chain store.
// ---------------------------------------------------------------------------
const ATTESTOR_REGISTRY: Attestor[] = [
  {
    id: 'att_mit',
    name: 'Massachusetts Institute of Technology',
    type: 'university',
    region: 'US',
    description: 'Top-ranked research university providing degree attestations.',
    stellar_address: 'GATECH0000000000000000000000000000000000000000000001',
    credentials_issued: 1420,
    active: true,
  },
  {
    id: 'att_usp',
    name: 'Universidade de São Paulo',
    type: 'university',
    region: 'BR',
    description: 'Largest university in Brazil; issues engineering degree credentials.',
    stellar_address: 'GAUSP000000000000000000000000000000000000000000000002',
    credentials_issued: 987,
    active: true,
  },
  {
    id: 'att_tum',
    name: 'Technical University of Munich',
    type: 'university',
    region: 'DE',
    description: 'Leading German technical university for engineering disciplines.',
    stellar_address: 'GATUMU00000000000000000000000000000000000000000000003',
    credentials_issued: 763,
    active: true,
  },
  {
    id: 'att_crea_br',
    name: 'CREA Brasil',
    type: 'licensing_body',
    region: 'BR',
    description: 'Federal Council of Engineering and Agronomy — Brazilian engineering licensor.',
    stellar_address: 'GACREA00000000000000000000000000000000000000000000004',
    credentials_issued: 3201,
    active: true,
  },
  {
    id: 'att_vdi_de',
    name: 'Verein Deutscher Ingenieure (VDI)',
    type: 'licensing_body',
    region: 'DE',
    description: 'Germany\'s largest engineering association, validates professional standing.',
    stellar_address: 'GAVDI000000000000000000000000000000000000000000000005',
    credentials_issued: 1834,
    active: true,
  },
  {
    id: 'att_ieee',
    name: 'IEEE — Institute of Electrical and Electronics Engineers',
    type: 'licensing_body',
    region: 'US',
    description: 'Global professional body for electrical and computer engineering.',
    stellar_address: 'GAIEE000000000000000000000000000000000000000000000006',
    credentials_issued: 5120,
    active: true,
  },
  {
    id: 'att_bosch',
    name: 'Robert Bosch GmbH',
    type: 'employer',
    region: 'DE',
    description: 'Multinational engineering and technology company; attests employment history.',
    stellar_address: 'GABOSC00000000000000000000000000000000000000000000007',
    credentials_issued: 412,
    active: true,
  },
  {
    id: 'att_embraer',
    name: 'Embraer S.A.',
    type: 'employer',
    region: 'BR',
    description: 'Brazilian aerospace manufacturer; issues employment attestations.',
    stellar_address: 'GAEMBR00000000000000000000000000000000000000000000008',
    credentials_issued: 289,
    active: true,
  },
  {
    id: 'att_spacex',
    name: 'SpaceX',
    type: 'employer',
    region: 'US',
    description: 'Aerospace manufacturer and space transportation services company.',
    stellar_address: 'GASPCE00000000000000000000000000000000000000000000009',
    credentials_issued: 178,
    active: false,
  },
  {
    id: 'att_mec_br',
    name: 'Ministério da Educação (MEC) — Brasil',
    type: 'government',
    region: 'BR',
    description: 'Brazilian federal education ministry; validates accredited institutions.',
    stellar_address: 'GAMEC000000000000000000000000000000000000000000000010',
    credentials_issued: 620,
    active: true,
  },
];

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createAttestorsRouter(): Router {
  const router = Router();

  /**
   * GET /api/attestors
   *
   * Returns a filterable list of registered attestors.
   *
   * Query params:
   *   type    — exact match on attestor type
   *   region  — exact match on region (case-insensitive)
   *   q       — substring search across name, region, and description
   *   active  — "true" / "false" to filter by active status
   */
  router.get('/', (req: Request, res: Response) => {
    const { type, region, q, active } = req.query;

    let results = [...ATTESTOR_REGISTRY];

    if (type && typeof type === 'string') {
      results = results.filter((a) => a.type === type);
    }

    if (region && typeof region === 'string') {
      results = results.filter(
        (a) => a.region.toLowerCase() === region.toLowerCase(),
      );
    }

    if (active !== undefined && typeof active === 'string') {
      const wantActive = active.toLowerCase() === 'true';
      results = results.filter((a) => a.active === wantActive);
    }

    if (q && typeof q === 'string') {
      const needle = q.toLowerCase();
      results = results.filter(
        (a) =>
          a.name.toLowerCase().includes(needle) ||
          a.region.toLowerCase().includes(needle) ||
          a.description.toLowerCase().includes(needle),
      );
    }

    res.json({
      total: results.length,
      attestors: results,
    });
  });

  /**
   * GET /api/attestors/:id
   *
   * Returns a single attestor record including credential stats.
   * Responds with 404 if the id is unknown.
   */
  router.get('/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const attestor = ATTESTOR_REGISTRY.find((a) => a.id === id);

    if (!attestor) {
      res.status(404).json({ error: `Attestor '${id}' not found` });
      return;
    }

    res.json(attestor);
  });

  /**
   * GET /api/attestors/:id/status
   *
   * Issue #875 — Returns live availability metrics for a single attestor:
   *   - uptime_ratio      fraction of successful pings in the last 24 h (0–1, null if no data)
   *   - avg_response_ms   average latency of successful pings (ms, null if no data)
   *   - active_credential_count  number of credentials the attestor has co-signed
   *   - last_seen         ISO-8601 timestamp of the most recent recorded ping
   *   - availability      human-readable tier: excellent | good | degraded | offline | unknown
   *
   * Responds with 404 if the attestor id is unknown.
   */
  router.get('/:id/status', (req: Request, res: Response) => {
    const { id } = req.params;
    const attestor = ATTESTOR_REGISTRY.find((a) => a.id === id);

    if (!attestor) {
      res.status(404).json({ error: `Attestor '${id}' not found` });
      return;
    }

    res.json(computeStatus(id, attestor.credentials_issued));
  });

  /**
   * POST /api/attestors/:id/status/ping
   *
   * Issue #875 — Record a heartbeat ping result for the attestor.  Called by
   * the monitoring agent (or the attestor node itself) after each health-check
   * probe.  The body is validated but intentionally kept minimal so the monitor
   * can fire-and-forget.
   *
   * Request body (JSON):
   *   { "ok": boolean, "response_ms": number }
   *
   * Responds with 204 No Content on success, 400 on bad input, 404 on unknown id.
   */
  router.post('/:id/status/ping', (req: Request, res: Response) => {
    const { id } = req.params;
    const attestor = ATTESTOR_REGISTRY.find((a) => a.id === id);

    if (!attestor) {
      res.status(404).json({ error: `Attestor '${id}' not found` });
      return;
    }

    const { ok, response_ms } = req.body as { ok?: unknown; response_ms?: unknown };

    if (typeof ok !== 'boolean') {
      res.status(400).json({ error: '"ok" must be a boolean' });
      return;
    }
    if (typeof response_ms !== 'number' || response_ms < 0 || !isFinite(response_ms)) {
      res.status(400).json({ error: '"response_ms" must be a non-negative finite number' });
      return;
    }

    recordPing(id, ok, response_ms);
    res.status(204).end();
  });

  return router;
}

export default createAttestorsRouter();
