/**
 * Issue #996 — Attestor Discovery API
 *
 * Provides a registry of known attestors (universities, licensing bodies,
 * employers) that credential holders can discover when building their quorum
 * slice.
 *
 * Endpoints:
 *   GET  /api/attestors              — list all attestors (filterable by type / region)
 *   GET  /api/attestors/:id          — get a single attestor with its credential stats
 *
 * Query parameters for the list endpoint:
 *   type    — filter by attestor type (e.g. "university", "licensing_body", "employer")
 *   region  — filter by region / country code (e.g. "BR", "DE", "US")
 *   q       — free-text search over name and region fields (case-insensitive)
 */

import { Router, Request, Response } from 'express';
import { respondNegotiated } from '../middleware/contentNegotiation.js';

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
   * Returns a paginated, filterable list of registered attestors.
   *
   * Query params:
   *   type    — exact match on attestor type
   *   region  — exact match on region (case-insensitive)
   *   q       — substring search across name and region
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

    respondNegotiated(req, res, { total: results.length, attestors: results }, {
      rootElement: 'attestors',
      itemElement: 'attestor',
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

  return router;
}

export default createAttestorsRouter();
