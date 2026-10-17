import { beforeEach, describe, expect, it, vi } from 'vitest';

const dnsMock = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: dnsMock.lookup }));

import { validateWebhookUrl, WebhookUrlValidationError } from '../src/services/webhookUrl.js';

describe('validateWebhookUrl', () => {
  beforeEach(() => {
    dnsMock.lookup.mockReset();
    dnsMock.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });

  it.each([
    'http://127.0.0.1/hook',
    'http://10.0.0.1/hook',
    'http://172.16.0.1/hook',
    'http://192.168.1.1/hook',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/hook',
    'http://[fc00::1]/hook',
    'http://[fe80::1]/hook',
    'http://[::ffff:127.0.0.1]/hook',
    'http://localhost/hook',
    'http://service.internal/hook',
  ])('rejects non-public address URL %s', async (url) => {
    await expect(validateWebhookUrl(url)).rejects.toBeInstanceOf(WebhookUrlValidationError);
  });

  it('rejects hostnames that resolve to any non-public address', async () => {
    dnsMock.lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.1.12', family: 4 },
    ]);
    await expect(validateWebhookUrl('https://hooks.example.com')).rejects.toThrow(/only to public addresses/);
  });

  it('rejects malformed, credentialed, and non-http URLs', async () => {
    await expect(validateWebhookUrl('not a URL')).rejects.toThrow(WebhookUrlValidationError);
    await expect(validateWebhookUrl('https://user:pass@example.com')).rejects.toThrow(/credentials/);
    await expect(validateWebhookUrl('file:///etc/passwd')).rejects.toThrow(/http or https/);
  });

  it('accepts a public IP literal or hostname resolving only to public addresses', async () => {
    await expect(validateWebhookUrl('https://93.184.216.34/hooks')).resolves.toBeUndefined();
    await expect(validateWebhookUrl('https://hooks.example.com')).resolves.toBeUndefined();
  });
});
