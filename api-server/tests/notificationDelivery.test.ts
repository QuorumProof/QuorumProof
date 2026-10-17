import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchNotification, flushPendingBatch, setPreferences } from '../src/notifications.js';
import { sendRecoveryCode } from '../src/notifications.js';

describe('notification provider delivery', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends notification email through SendGrid without logging its contents', async () => {
    vi.stubEnv('SENDGRID_API_KEY', 'test-api-key');
    vi.stubEnv('SENDGRID_FROM_EMAIL', 'notifications@example.test');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal('fetch', fetchMock);
    const logSpy = vi.spyOn(console, 'log');

    await setPreferences({
      address: 'G_NOTIFY_DELIVERY',
      email: 'holder@example.test',
      channels: ['email'],
      events: ['credential_issued'],
      enabled: true,
    });
    await dispatchNotification('G_NOTIFY_DELIVERY', 'credential_issued', 42);
    await flushPendingBatch('G_NOTIFY_DELIVERY');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      personalizations: [{ to: [{ email: 'holder@example.test' }] }],
      content: [{ type: 'text/plain', value: expect.stringContaining('#42') }],
    });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('sends recovery SMS through Twilio', async () => {
    vi.stubEnv('TWILIO_ACCOUNT_SID', 'test-account');
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'test-token');
    vi.stubEnv('TWILIO_FROM_PHONE', '+15555550100');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal('fetch', fetchMock);

    await sendRecoveryCode('sms', '+15555550200', '123456');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.twilio.com/2010-04-01/Accounts/test-account/Messages.json',
    );
    const params = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(params.get('To')).toBe('+15555550200');
    expect(params.get('Body')).toContain('123456');
  });

  it('delivers recovery codes by email and fails explicitly without provider configuration', async () => {
    vi.stubEnv('SENDGRID_API_KEY', 'test-api-key');
    vi.stubEnv('SENDGRID_FROM_EMAIL', 'notifications@example.test');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal('fetch', fetchMock);

    await sendRecoveryCode('email', 'holder@example.test', '123456');

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).content[0].value).toContain('123456');
    vi.unstubAllEnvs();
    await expect(sendRecoveryCode('email', 'holder@example.test', '654321'))
      .rejects.toThrow('Email delivery is not configured');
  });
});
