import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiClient, ApiError, apiClient } from '../apiClient';

// Mock fetch
global.fetch = vi.fn();

describe('ApiClient', () => {
  let client: ApiClient;

  beforeEach(() => {
    client = new ApiClient('http://localhost:3000', 5000);
    (global.fetch as any).mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  describe('GET requests', () => {
    it('should perform a successful GET request', async () => {
      const mockData = { id: 1, name: 'Test' };
      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockData),
      });

      const result = await client.get('/test');
      expect(result).toEqual(mockData);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3000/test',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should throw ApiError on non-ok response', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: () => Promise.resolve({ error: 'Not found' }),
      });

      await expect(client.get('/notfound')).rejects.toThrow(ApiError);
    });

    it('should validate response with provided validator', async () => {
      const validator = (data: any) => data.id === 1;
      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 2 }),
      });

      await expect(client.get('/test', { validator })).rejects.toThrow('Invalid response format');
    });

    it('should support request cancellation by key', async () => {
      const controller = new AbortController();
      (global.fetch as any).mockImplementation(() => {
        throw new DOMException('The user aborted a request.', 'AbortError');
      });

      const promise = client.get('/test', { requestKey: 'test-key' });
      client.cancelRequest('test-key');

      // Give the cancellation time to propagate
      await new Promise(r => setTimeout(r, 10));
    });
  });

  describe('POST requests', () => {
    it('should perform a successful POST request', async () => {
      const mockData = { id: 1, name: 'Created' };
      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 201,
        json: () => Promise.resolve(mockData),
      });

      const result = await client.post('/test', { name: 'Test' });
      expect(result).toEqual(mockData);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3000/test',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Test' }),
        })
      );
    });

    it('should throw ApiError on non-ok POST response', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: () => Promise.resolve({ error: 'Invalid input' }),
      });

      await expect(client.post('/test', {})).rejects.toThrow(ApiError);
    });

    it('should validate POST response', async () => {
      const validator = (data: any) => typeof data.id === 'number';
      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 'not-a-number' }),
      });

      await expect(client.post('/test', {}, { validator })).rejects.toThrow(
        'Invalid response format'
      );
    });
  });

  describe('PUT requests', () => {
    it('should perform a successful PUT request', async () => {
      const mockData = { id: 1, name: 'Updated' };
      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockData),
      });

      const result = await client.put('/test/1', { name: 'Updated' });
      expect(result).toEqual(mockData);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3000/test/1',
        expect.objectContaining({ method: 'PUT' })
      );
    });
  });

  describe('DELETE requests', () => {
    it('should perform a successful DELETE request', async () => {
      const mockData = { success: true };
      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockData),
      });

      const result = await client.delete('/test/1');
      expect(result).toEqual(mockData);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3000/test/1',
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });

  describe('request cancellation', () => {
    it('should cancel a specific request by key', async () => {
      (global.fetch as any).mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ ok: true, json: () => ({}) }), 100);
          })
      );

      const promise = client.get('/test', { requestKey: 'unique-key' });
      client.cancelRequest('unique-key');

      // The promise should be rejected due to abort
      await expect(promise).rejects.toThrow();
    });

    it('should cancel all pending requests', async () => {
      (global.fetch as any).mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ ok: true, json: () => ({}) }), 100);
          })
      );

      const p1 = client.get('/test1', { requestKey: 'key1' });
      const p2 = client.get('/test2', { requestKey: 'key2' });

      client.cancelAll();

      await expect(Promise.all([p1, p2])).rejects.toThrow();
    });

    it('should abort a request on timeout', async () => {
      vi.useFakeTimers();

      (global.fetch as any).mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ ok: true, json: () => ({}) }), 10000);
          })
      );

      const promise = client.get('/test', { timeout: 1000 });

      vi.advanceTimersByTime(1100);

      await expect(promise).rejects.toThrow();
      vi.useRealTimers();
    });
  });

  describe('error handling', () => {
    it('should normalize error responses', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.resolve({ error: 'Database connection failed' }),
      });

      try {
        await client.get('/test');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(500);
        expect((err as ApiError).message).toBe('Database connection failed');
      }
    });

    it('should handle network errors', async () => {
      (global.fetch as any).mockRejectedValue(new TypeError('Network request failed'));

      await expect(client.get('/test')).rejects.toThrow(ApiError);
    });

    it('should handle invalid JSON responses', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError('Invalid JSON')),
      });

      await expect(client.get('/test')).rejects.toThrow();
    });
  });

  describe('custom headers', () => {
    it('should support custom Content-Type for POST', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });

      await client.post('/test', { data: 'test' });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });
  });

  describe('singleton instance', () => {
    it('should export a shared apiClient instance', () => {
      expect(apiClient).toBeInstanceOf(ApiClient);
    });
  });
});
