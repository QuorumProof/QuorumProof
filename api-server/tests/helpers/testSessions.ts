import { afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  SessionManager,
  _setDefaultSessionManagerForTest,
} from '../../src/services/sessionManager.js';

/**
 * Installs an isolated session manager for the enclosing describe block and
 * returns a helper that issues real signed access tokens for a given role.
 * Tokens go through the same validation path as production requests.
 */
export function useTestSessions(): (userId: string, role?: string) => string {
  let tempDir = '';
  let manager: SessionManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-sessions-'));
    manager = new SessionManager({ dataDir: tempDir });
    _setDefaultSessionManagerForTest(manager);
  });

  afterEach(() => {
    _setDefaultSessionManagerForTest(undefined);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return (userId: string, role?: string): string =>
    manager.createSession(userId, { mfaVerified: true, role }).accessToken;
}
