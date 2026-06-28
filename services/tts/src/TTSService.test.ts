import { describe, it, expect, vi } from 'vitest';
import { TTSError, TTSService, type TTSProvider, type TTSResponse } from './TTSService.js';

const DUMMY_RESPONSE: TTSResponse = {
  audioBuffer: Buffer.from('audio'),
  durationMs: 1000,
};

function makeProvider(responses: Array<TTSResponse | TTSError>): TTSProvider {
  let call = 0;
  return {
    synthesize: vi.fn(async () => {
      const r = responses[call++];
      if (r instanceof TTSError) throw r;
      return r;
    }),
  };
}

/** Sleep stub that records delays without actually waiting */
function makeSleepSpy() {
  const delays: number[] = [];
  const sleep = async (ms: number) => { delays.push(ms); };
  return { sleep, delays };
}

describe('TTSService retry logic', () => {
  it('returns immediately on first-attempt success without sleeping', async () => {
    const provider = makeProvider([DUMMY_RESPONSE]);
    const { sleep, delays } = makeSleepSpy();
    const svc = new TTSService(provider, { sleep, random: () => 0.5 });

    const result = await svc.synthesize({ text: 'hello' });

    expect(result).toBe(DUMMY_RESPONSE);
    expect(delays).toHaveLength(0);
    expect(provider.synthesize).toHaveBeenCalledTimes(1);
  });

  it('retries three times then throws on repeated 429 errors', async () => {
    const transient = new TTSError('rate limited', 429, true);
    const provider = makeProvider([transient, transient, transient, transient]);
    const { sleep, delays } = makeSleepSpy();
    const svc = new TTSService(provider, { maxRetries: 3, sleep, random: () => 0.5 });

    await expect(svc.synthesize({ text: 'hello' })).rejects.toBeInstanceOf(TTSError);
    expect(provider.synthesize).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    expect(delays).toHaveLength(3);
  });

  it('does NOT retry on 400 (non-retriable)', async () => {
    const badRequest = new TTSError('bad request', 400, false);
    const provider = makeProvider([badRequest]);
    const { sleep } = makeSleepSpy();
    const svc = new TTSService(provider, { sleep, random: () => 0.5 });

    await expect(svc.synthesize({ text: 'hello' })).rejects.toThrow('bad request');
    expect(provider.synthesize).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 401 (non-retriable)', async () => {
    const unauthorized = new TTSError('unauthorized', 401, false);
    const provider = makeProvider([unauthorized]);
    const { sleep } = makeSleepSpy();
    const svc = new TTSService(provider, { sleep, random: () => 0.5 });

    await expect(svc.synthesize({ text: 'hello' })).rejects.toThrow('unauthorized');
    expect(provider.synthesize).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 403 (non-retriable)', async () => {
    const forbidden = new TTSError('forbidden', 403, false);
    const provider = makeProvider([forbidden]);
    const { sleep } = makeSleepSpy();
    const svc = new TTSService(provider, { sleep, random: () => 0.5 });

    await expect(svc.synthesize({ text: 'hello' })).rejects.toThrow('forbidden');
    expect(provider.synthesize).toHaveBeenCalledTimes(1);
  });

  it('succeeds on the second attempt after a transient 503', async () => {
    const transient = new TTSError('service unavailable', 503, true);
    const provider = makeProvider([transient, DUMMY_RESPONSE]);
    const { sleep, delays } = makeSleepSpy();
    const svc = new TTSService(provider, { sleep, random: () => 0.5 });

    const result = await svc.synthesize({ text: 'hello' });
    expect(result).toBe(DUMMY_RESPONSE);
    expect(delays).toHaveLength(1);
  });

  it('backoff delay is capped at maxDelayMs', async () => {
    const transient = new TTSError('error', 500, true);
    const provider = makeProvider([transient, transient, transient, transient]);
    const { sleep, delays } = makeSleepSpy();
    const maxDelayMs = 100;
    // random always returns 1 so delay = floor(1 * min(100, 1000 * 2^n))
    const svc = new TTSService(provider, { maxRetries: 3, maxDelayMs, sleep, random: () => 1 });

    await expect(svc.synthesize({ text: 'hello' })).rejects.toBeInstanceOf(TTSError);
    delays.forEach(d => expect(d).toBeLessThanOrEqual(maxDelayMs));
  });

  it('reads maxRetries and maxDelayMs from environment variables', async () => {
    const transient = new TTSError('error', 500, true);
    const provider = makeProvider([transient, transient]);
    const { sleep } = makeSleepSpy();

    const prev = { retries: process.env.TTS_MAX_RETRIES, delay: process.env.TTS_MAX_DELAY_MS };
    process.env.TTS_MAX_RETRIES = '1';
    process.env.TTS_MAX_DELAY_MS = '500';
    try {
      const svc = new TTSService(provider, { sleep, random: () => 0.5 });
      await expect(svc.synthesize({ text: 'hello' })).rejects.toBeInstanceOf(TTSError);
      expect(provider.synthesize).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
    } finally {
      process.env.TTS_MAX_RETRIES = prev.retries;
      process.env.TTS_MAX_DELAY_MS = prev.delay;
    }
  });
});
