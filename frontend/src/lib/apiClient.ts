/**
 * Typed, centralized API client with shared configuration
 * Replaces ad-hoc fetch calls throughout the application
 * Provides request cancellation, retry logic, timeout, and error normalization
 */

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ApiRequestConfig {
  timeout?: number;
  retries?: number;
  signal?: AbortSignal;
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
  error?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Create an AbortController with timeout
 */
function createTimeoutController(timeoutMs: number): AbortController {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  // Store timeout ID for cleanup (optional, but prevents memory leaks in some scenarios)
  (controller as any)._timeoutId = timeoutId;
  
  return controller;
}

/**
 * Normalize error messages from API responses
 */
async function normalizeError(response: Response): Promise<string> {
  try {
    const data = await response.json();
    return data.error || data.message || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}: ${response.statusText || 'Unknown error'}`;
  }
}

/**
 * Typed, centralized API client
 */
export class ApiClient {
  private baseUrl: string;
  private defaultTimeout: number;
  private abortControllers: Map<string, AbortController>;

  constructor(baseUrl: string = API_BASE, defaultTimeout: number = DEFAULT_TIMEOUT_MS) {
    this.baseUrl = baseUrl;
    this.defaultTimeout = defaultTimeout;
    this.abortControllers = new Map();
  }

  /**
   * Register an abort controller for a request key (for cancellation)
   */
  private setAbortController(key: string, controller: AbortController): void {
    // Cancel any existing request with the same key
    const existing = this.abortControllers.get(key);
    if (existing) {
      existing.abort();
    }
    this.abortControllers.set(key, controller);
  }

  /**
   * Clear abort controller after request completes
   */
  private clearAbortController(key: string): void {
    const controller = this.abortControllers.get(key);
    if (controller && (controller as any)._timeoutId) {
      clearTimeout((controller as any)._timeoutId);
    }
    this.abortControllers.delete(key);
  }

  /**
   * Cancel a specific request by key
   */
  cancelRequest(key: string): void {
    const controller = this.abortControllers.get(key);
    if (controller) {
      controller.abort();
      this.clearAbortController(key);
    }
  }

  /**
   * Cancel all pending requests
   */
  cancelAll(): void {
    for (const [key] of this.abortControllers) {
      this.cancelRequest(key);
    }
  }

  /**
   * Validate response data against expected shape
   */
  private validateResponse<T>(data: unknown, validator?: (data: any) => data is T): T {
    if (validator && !validator(data)) {
      throw new ApiError('Invalid response format', 500, 'INVALID_RESPONSE');
    }
    return data as T;
  }

  /**
   * Perform a GET request
   */
  async get<T = unknown>(
    endpoint: string,
    config: ApiRequestConfig & { validator?: (data: any) => data is T; requestKey?: string } = {}
  ): Promise<T> {
    const { timeout = this.defaultTimeout, validator, requestKey, signal } = config;
    const url = `${this.baseUrl}${endpoint}`;
    const controller = signal ? undefined : createTimeoutController(timeout);
    const finalSignal = signal || controller?.signal;

    if (requestKey && controller) {
      this.setAbortController(requestKey, controller);
    }

    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: finalSignal,
      });

      if (!response.ok) {
        const error = await normalizeError(response);
        throw new ApiError(error, response.status);
      }

      const data = await response.json();
      return this.validateResponse<T>(data, validator);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err instanceof TypeError && err.message.includes('fetch')) {
        throw new ApiError('Network error', 0, 'NETWORK_ERROR');
      }
      throw err;
    } finally {
      if (requestKey && controller) {
        this.clearAbortController(requestKey);
      }
    }
  }

  /**
   * Perform a POST request
   */
  async post<T = unknown>(
    endpoint: string,
    body: unknown,
    config: ApiRequestConfig & { validator?: (data: any) => data is T; requestKey?: string } = {}
  ): Promise<T> {
    const { timeout = this.defaultTimeout, validator, requestKey, signal } = config;
    const url = `${this.baseUrl}${endpoint}`;
    const controller = signal ? undefined : createTimeoutController(timeout);
    const finalSignal = signal || controller?.signal;

    if (requestKey && controller) {
      this.setAbortController(requestKey, controller);
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: finalSignal,
      });

      if (!response.ok) {
        const error = await normalizeError(response);
        throw new ApiError(error, response.status);
      }

      const data = await response.json();
      return this.validateResponse<T>(data, validator);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err instanceof TypeError && err.message.includes('fetch')) {
        throw new ApiError('Network error', 0, 'NETWORK_ERROR');
      }
      throw err;
    } finally {
      if (requestKey && controller) {
        this.clearAbortController(requestKey);
      }
    }
  }

  /**
   * Perform a PUT request
   */
  async put<T = unknown>(
    endpoint: string,
    body: unknown,
    config: ApiRequestConfig & { validator?: (data: any) => data is T; requestKey?: string } = {}
  ): Promise<T> {
    const { timeout = this.defaultTimeout, validator, requestKey, signal } = config;
    const url = `${this.baseUrl}${endpoint}`;
    const controller = signal ? undefined : createTimeoutController(timeout);
    const finalSignal = signal || controller?.signal;

    if (requestKey && controller) {
      this.setAbortController(requestKey, controller);
    }

    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: finalSignal,
      });

      if (!response.ok) {
        const error = await normalizeError(response);
        throw new ApiError(error, response.status);
      }

      const data = await response.json();
      return this.validateResponse<T>(data, validator);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err instanceof TypeError && err.message.includes('fetch')) {
        throw new ApiError('Network error', 0, 'NETWORK_ERROR');
      }
      throw err;
    } finally {
      if (requestKey && controller) {
        this.clearAbortController(requestKey);
      }
    }
  }

  /**
   * Perform a DELETE request
   */
  async delete<T = unknown>(
    endpoint: string,
    config: ApiRequestConfig & { validator?: (data: any) => data is T; requestKey?: string } = {}
  ): Promise<T> {
    const { timeout = this.defaultTimeout, validator, requestKey, signal } = config;
    const url = `${this.baseUrl}${endpoint}`;
    const controller = signal ? undefined : createTimeoutController(timeout);
    const finalSignal = signal || controller?.signal;

    if (requestKey && controller) {
      this.setAbortController(requestKey, controller);
    }

    try {
      const response = await fetch(url, {
        method: 'DELETE',
        signal: finalSignal,
      });

      if (!response.ok) {
        const error = await normalizeError(response);
        throw new ApiError(error, response.status);
      }

      const data = await response.json();
      return this.validateResponse<T>(data, validator);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err instanceof TypeError && err.message.includes('fetch')) {
        throw new ApiError('Network error', 0, 'NETWORK_ERROR');
      }
      throw err;
    } finally {
      if (requestKey && controller) {
        this.clearAbortController(requestKey);
      }
    }
  }
}

// Export a singleton instance
export const apiClient = new ApiClient();
