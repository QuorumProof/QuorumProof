# QuorumProof TTS Service

A provider-agnostic Text-to-Speech (TTS) client library for the QuorumProof platform.

## Purpose

`TTSService` enables QuorumProof to read credential and attestation status aloud,
supporting accessibility requirements for users with visual impairments or who prefer
audio feedback. Example use cases:

- Reading a credential verification result aloud ("Your Mechanical Engineering license
  from CREA Brasil has been verified by 3 attestors.")
- Narrating attestation status changes from the real-time WebSocket stream
- Providing audio guidance through the quorum-slice setup wizard in the frontend

## Status: Library-only (no near-term standalone consumer wired up)

This service is currently a **library** — it ships `TTSService.ts` and a test suite,
but is **not yet imported by `api-server`, `frontend`, or `dashboard`**. There is no
standalone HTTP server wrapping it. The Dockerfile in this directory is provided for
teams who want to run TTS synthesis as a sidecar or standalone microservice; wiring it
into the frontend accessibility layer is tracked in the roadmap (see below).

If you land here expecting a live integration, check the roadmap section at the bottom
of this file before assuming something is broken.

## Supported Providers

`TTSService` is provider-agnostic: it accepts any object implementing the `TTSProvider`
interface. The following providers are commonly used with it, though adapters are not
included in this package and must be written by the caller:

| Provider | Notes |
|---|---|
| **ElevenLabs** | High-quality voices; primary target. Requires `ELEVENLABS_API_KEY`. |
| **Google Cloud TTS** | Broad language coverage; useful for multilingual credential narration. Requires `GOOGLE_APPLICATION_CREDENTIALS`. |
| **AWS Polly** | Alternative if already on AWS. Uses standard AWS SDK credentials. |

## Installation

This package is not published to npm. Install it from the monorepo:

```bash
# from api-server or frontend, using a relative file: reference
npm install ../../services/tts
```

Or import the TypeScript source directly in a monorepo setup with workspace references.

## Usage

```typescript
import { TTSService, TTSError } from '@quorumproof/tts-service';

// Implement TTSProvider for your chosen backend (example: ElevenLabs)
const elevenLabsProvider = {
  async synthesize(req) {
    const resp = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + voiceId, {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY! },
      body: JSON.stringify({ text: req.text }),
    });
    if (!resp.ok) throw new TTSError(resp.statusText, resp.status, resp.status >= 500 || resp.status === 429);
    const audioBuffer = Buffer.from(await resp.arrayBuffer());
    return { audioBuffer, durationMs: audioBuffer.length / 24 }; // approximate
  },
};

const tts = new TTSService(elevenLabsProvider, {
  maxRetries: 3,       // or set TTS_MAX_RETRIES env var
  maxDelayMs: 60_000,  // or set TTS_MAX_DELAY_MS env var
});

const { audioBuffer } = await tts.synthesize({
  text: 'Your credential has been attested by 3 nodes.',
  voiceId: 'rachel',
  languageCode: 'en-US',
});
```

## Retry Logic

`TTSService` implements **full-jitter exponential backoff** (equal to the AWS "full
jitter" recommendation):

- Delay for attempt `n` is drawn uniformly from `[0, min(maxDelayMs, 1000 × 2^n)]`.
- Retriable status codes: `408`, `429`, `500`, `502`, `503`, `504`.
- Non-retriable status codes: `400`, `401`, `403` — thrown immediately without retry.
- Both `maxRetries` and `maxDelayMs` are configurable via constructor options or the
  `TTS_MAX_RETRIES` / `TTS_MAX_DELAY_MS` environment variables.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `TTS_MAX_RETRIES` | `3` | Maximum retry attempts after the initial call. |
| `TTS_MAX_DELAY_MS` | `60000` | Cap on the computed backoff delay in milliseconds. |

## Running as a Standalone Service (Dockerfile)

```bash
# Build
docker build -t quorumproof-tts -f services/tts/Dockerfile services/tts

# Run (pass provider credentials via env)
docker run -p 3010:3010 \
  -e ELEVENLABS_API_KEY=... \
  -e TTS_MAX_RETRIES=3 \
  quorumproof-tts
```

The container exposes port `3010` and expects a thin HTTP wrapper (not included) to be
added as `src/server.ts`. Until that wrapper is added the container will exit immediately.

## Running Tests

```bash
cd services/tts
npm install
npm test
```

All tests run deterministically (no real network calls, no actual sleeping):
sleep and random are injected via `TTSServiceConfig`.

## Roadmap

| Milestone | Description |
|---|---|
| **v1.1** | Wire `TTSService` into the frontend credential-verification page as an optional accessibility layer (screen-reader-friendly audio confirmation). |
| **v1.2** | Add an ElevenLabs provider adapter and a Google Cloud TTS provider adapter as first-class modules in this package. |
| **v2.0** | Expose a REST endpoint (`POST /synthesize`) so the frontend can call TTS without bundling the provider SDK. |
