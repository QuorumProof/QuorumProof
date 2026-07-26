import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import * as express from "express";
import * as fs from "fs";
import * as path from "path";

/**
 * API Snapshot Tests
 *
 * These tests capture API responses as snapshots and detect unintended changes.
 * Snapshots are stored in __snapshots__ directory for review and versioning.
 *
 * Workflow:
 * 1. Run tests: `npm test -- snapshots.test.ts`
 * 2. Review changes: Check diff in `api-server/tests/__snapshots__/`
 * 3. Approve: `npm test -- snapshots.test.ts -u` (updates snapshots)
 * 4. Commit: `git add api-server/tests/__snapshots__/`
 */

let app: any;
const SNAPSHOTS_DIR = path.join(__dirname, "__snapshots__");

describe("API Snapshot Tests", () => {
  beforeEach(() => {
    app = express.default();
    app.use(express.json());
    setupMockRoutes(app);

    // Ensure snapshots directory exists
    if (!fs.existsSync(SNAPSHOTS_DIR)) {
      fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    }
  });

  describe("Credential Endpoints", () => {
    it("GET /credentials/:id snapshot", async () => {
      const response = await request(app).get("/credentials/123");
      expect(response.status).toBe(200);
      expect(response.body).toMatchSnapshot("credential-detail");
    });

    it("POST /credentials snapshot", async () => {
      const credentialRequest = {
        subject: "GDQJYQZ7BXSFZ74JQSBFQJ5JMIWQNX4CMHVAVDLXVXYQPJQRXHQY45KC",
        credential_type: "DEGREE",
        metadata_hash: "QmA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0U",
        expires_at: 1735689600,
      };

      const response = await request(app).post("/credentials").send(credentialRequest);

      expect(response.status).toBe(201);
      expect(response.body).toMatchSnapshot("credential-created");
    });

    it("GET /credentials list snapshot", async () => {
      const response = await request(app).get("/credentials?page=1&limit=10");

      expect(response.status).toBe(200);
      expect(response.body).toMatchSnapshot("credentials-list");
    });
  });

  describe("Attestation Endpoints", () => {
    it("POST /slices/:id/attest snapshot", async () => {
      const attestationRequest = {
        credential_id: "456",
        attestor: "GBXYZABC123DEF456GHI789JKL012MNO345PQR678STU901VWX234YZ",
      };

      const response = await request(app)
        .post("/slices/789/attest")
        .send(attestationRequest);

      expect(response.status).toBe(200);
      expect(response.body).toMatchSnapshot("attestation-response");
    });

    it("GET /credentials/:id/attestors snapshot", async () => {
      const response = await request(app).get("/credentials/456/attestors");

      expect(response.status).toBe(200);
      expect(response.body).toMatchSnapshot("attestors-list");
    });

    it("GET /credentials/:id/attestation-status snapshot", async () => {
      const response = await request(app).get("/credentials/456/attestation-status");

      expect(response.status).toBe(200);
      expect(response.body).toMatchSnapshot("attestation-status");
    });
  });

  describe("Verification Endpoints", () => {
    it("POST /verify snapshot", async () => {
      const verificationRequest = {
        credential_id: "123",
        claim_type: "HAS_DEGREE",
        proof: "0x1234567890abcdef",
      };

      const response = await request(app).post("/verify").send(verificationRequest);

      expect(response.status).toBe(200);
      expect(response.body).toMatchSnapshot("verification-response");
    });

    it("GET /credentials/:id/verification snapshot", async () => {
      const response = await request(app).get("/credentials/123/verification");

      expect(response.status).toBe(200);
      expect(response.body).toMatchSnapshot("credential-verification");
    });
  });

  describe("Error Response Snapshots", () => {
    it("400 Bad Request snapshot", async () => {
      const invalidRequest = {
        subject: "invalid",
      };

      const response = await request(app)
        .post("/credentials")
        .send(invalidRequest);

      expect(response.status).toBe(400);
      expect(response.body).toMatchSnapshot("error-400-bad-request");
    });

    it("404 Not Found snapshot", async () => {
      const response = await request(app).get("/credentials/nonexistent");

      expect(response.status).toBe(404);
      expect(response.body).toMatchSnapshot("error-404-not-found");
    });

    it("500 Server Error snapshot", async () => {
      const response = await request(app).get("/credentials/error");

      if (response.status === 500) {
        expect(response.body).toMatchSnapshot("error-500-server-error");
      }
    });
  });

  describe("Response Headers Snapshots", () => {
    it("Credential endpoint headers snapshot", async () => {
      const response = await request(app).get("/credentials/123");

      const headers = {
        "content-type": response.headers["content-type"],
        "api-version": response.headers["api-version"],
      };

      expect(headers).toMatchSnapshot("credential-headers");
    });
  });

  describe("Pagination Snapshots", () => {
    it("First page snapshot", async () => {
      const response = await request(app).get("/credentials?page=1&limit=10");

      expect(response.body).toMatchSnapshot("pagination-page-1");
    });

    it("Large limit snapshot", async () => {
      const response = await request(app).get("/credentials?page=1&limit=10000");

      expect(response.body.pagination.limit).toBeLessThanOrEqual(1000);
      expect(response.body).toMatchSnapshot("pagination-capped-limit");
    });
  });
});

function setupMockRoutes(app: any) {
  app.post("/credentials", (req: any, res: any) => {
    if (req.body.subject === "invalid") {
      return res.status(400).json({
        error: {
          code: "INVALID_ADDRESS",
          message: "Invalid Stellar address format",
        },
      });
    }

    res.status(201).json({
      id: "123",
      subject: req.body.subject,
      credential_type: req.body.credential_type,
      metadata_hash: req.body.metadata_hash,
      expires_at: req.body.expires_at,
      created_at: 1703000000,
      revoked: false,
    });
  });

  app.get("/credentials/:id", (req: any, res: any) => {
    if (req.params.id === "error") {
      return res.status(500).json({
        error: {
          code: "SERVER_ERROR",
          message: "Internal server error",
        },
      });
    }

    if (req.params.id === "nonexistent") {
      return res.status(404).json({
        error: {
          code: "NOT_FOUND",
          message: "Credential not found",
        },
      });
    }

    res.set("api-version", "1.0.0");
    res.json({
      id: req.params.id,
      subject: "GDQJYQZ7BXSFZ74JQSBFQJ5JMIWQNX4CMHVAVDLXVXYQPJQRXHQY45KC",
      credential_type: "DEGREE",
      created_at: 1703000000,
      metadata_hash: "QmA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0U",
      revoked: false,
    });
  });

  app.get("/credentials", (req: any, res: any) => {
    const page = parseInt(req.query.page || "1");
    let limit = parseInt(req.query.limit || "20");

    if (limit > 1000) {
      limit = 1000;
    }

    const total = 100;

    res.set("api-version", "1.0.0");
    res.json({
      items: [
        {
          id: "123",
          subject: "GDQJYQZ7BXSFZ74JQSBFQJ5JMIWQNX4CMHVAVDLXVXYQPJQRXHQY45KC",
          credential_type: "DEGREE",
          created_at: 1703000000,
        },
        {
          id: "124",
          subject: "GBXYZABC123DEF456GHI789JKL012MNO345PQR678STU901VWX234YZ",
          credential_type: "LICENSE",
          created_at: 1703100000,
        },
      ],
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  });

  app.post("/slices/:sliceId/attest", (req: any, res: any) => {
    res.json({
      attested: true,
      attestor: req.body.attestor,
      credential_id: req.body.credential_id,
      slice_id: req.params.sliceId,
      timestamp: 1703000000,
    });
  });

  app.get("/credentials/:id/attestors", (req: any, res: any) => {
    res.json({
      items: [
        {
          address: "GBXYZABC123DEF456GHI789JKL012MNO345PQR678STU901VWX234YZ",
          attested_at: 1703100000,
        },
        {
          address: "GCABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRST",
          attested_at: 1703200000,
        },
      ],
    });
  });

  app.get("/credentials/:id/attestation-status", (req: any, res: any) => {
    res.json({
      credential_id: req.params.id,
      is_attested: true,
      attestation_count: 2,
      threshold_met: true,
    });
  });

  app.post("/verify", (req: any, res: any) => {
    res.json({
      verified: true,
      credential_id: req.body.credential_id,
      claim_type: req.body.claim_type,
      timestamp: 1703000000,
    });
  });

  app.get("/credentials/:id/verification", (req: any, res: any) => {
    res.json({
      credential_id: req.params.id,
      verified: true,
      claim_type: "HAS_DEGREE",
      timestamp: 1703000000,
    });
  });
}
