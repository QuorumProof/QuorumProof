import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import timeLockPuzzleRouter from '../src/routes/timeLockPuzzle.js';

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/time-lock-puzzle', timeLockPuzzleRouter);
  return app;
}

describe('Time-lock puzzle route validation', () => {
  it('rejects an invalid generate difficulty', async () => {
    const response = await request(createApp())
      .post('/api/time-lock-puzzle/generate')
      .send({ difficulty: 'extreme' });

    expect(response.status).toBe(400);
    expect(response.body.location).toBe('body');
  });

  it('defaults a missing generate difficulty to medium', async () => {
    const response = await request(createApp())
      .post('/api/time-lock-puzzle/generate')
      .send({});

    expect(response.status).toBe(201);
    expect(response.body.data.difficulty).toBe('medium');
  });

  it('rejects an invalid puzzle ID on solve', async () => {
    const response = await request(createApp())
      .post('/api/time-lock-puzzle/not-a-puzzle/solve')
      .send();

    expect(response.status).toBe(400);
    expect(response.body.location).toBe('params');
  });

  it('rejects a solution that exceeds the 64-character bound', async () => {
    const response = await request(createApp())
      .post('/api/time-lock-puzzle/puzzle_123_abcdef/verify')
      .send({ solution: 'a'.repeat(65) });

    expect(response.status).toBe(400);
    expect(response.body.location).toBe('body');
  });

  it('rejects a non-hex solution', async () => {
    const response = await request(createApp())
      .post('/api/time-lock-puzzle/puzzle_123_abcdef/verify')
      .send({ solution: 'z'.repeat(64) });

    expect(response.status).toBe(400);
    expect(response.body.location).toBe('body');
  });
});
