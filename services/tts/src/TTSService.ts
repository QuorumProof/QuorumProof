/**
 * TTSService — wraps ElevenLabs / Google Cloud TTS with exponential backoff
 * and full jitter on transient errors (429, 5xx).
 *
 * Configuration (environment variables):
 *   TTS_MAX_RETRIES   — maximum retry attempts before giving up (default: 3)
 *   TTS_MAX_DELAY_MS  — cap on the computed backoff delay in ms (default: 60000)
 */

export interface TTSRequest {
  text: string;
  voiceId?: string;
  languageCode?: string;
}

export interface TTSResponse {
  audioBuffer: Buffer;
  durationMs: number;
}

export interface TTSProvider {
  synthesize(req: TTSRequest): Promise<TTSResponse>;
}

export interface TTSServiceConfig {
  maxRetries?: number;
  maxDelayMs?: number;
  /** Injected for deterministic tests; defaults to Math.random */
  random?: () => number;
  /** Injected for deterministic tests; defaults to a real setTimeout-based sleep */
  sleep?: (ms: number) => Promise<void>;
}

export class TTSError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly retriable: boolean,
  ) {
    super(message);
    this.name = 'TTSError';
  }
}

const RETRIABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const NON_RETRIABLE_STATUS_CODES = new Set([400, 401, 403]);

function isRetriable(statusCode: number): boolean {
  if (NON_RETRIABLE_STATUS_CODES.has(statusCode)) return false;
  return RETRIABLE_STATUS_CODES.has(statusCode);
}

/** Full-jitter delay: uniform random in [0, min(maxDelayMs, baseMs * 2^attempt)] */
function computeBackoffMs(attempt: number, maxDelayMs: number, random: () => number): number {
  const exponentialCap = Math.min(maxDelayMs, 1000 * Math.pow(2, attempt));
  return Math.floor(random() * exponentialCap);
}

export class TTSService {
  private readonly maxRetries: number;
  private readonly maxDelayMs: number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly provider: TTSProvider,
    config: TTSServiceConfig = {},
  ) {
    this.maxRetries = config.maxRetries ?? Number(process.env.TTS_MAX_RETRIES ?? 3);
    this.maxDelayMs = config.maxDelayMs ?? Number(process.env.TTS_MAX_DELAY_MS ?? 60_000);
    this.random = config.random ?? Math.random.bind(Math);
    this.sleep = config.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
  }

  async synthesize(req: TTSRequest): Promise<TTSResponse> {
    let lastError: TTSError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.provider.synthesize(req);
      } catch (err: unknown) {
        const ttsErr = err instanceof TTSError
          ? err
          : new TTSError(String(err), 500, true);

        if (!ttsErr.retriable) throw ttsErr;

        lastError = ttsErr;

        if (attempt < this.maxRetries) {
          const delayMs = computeBackoffMs(attempt, this.maxDelayMs, this.random);
          await this.sleep(delayMs);
        }
      }
    }

    throw lastError!;
  }
}
