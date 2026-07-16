import { AuthError } from './AuthError.ts';

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}

export interface RateLimiterDiagnostics {
  windowMs: number;
  max: number;
  trackedKeys: number;
}

// Fixed-window rate limiting, keyed by caller (a Principal's subject, or
// the request IP when unauthenticated — see middleware/rateLimit.middleware.ts).
// In-memory and per-process — the same reference-implementation trade-off
// as InMemoryVectorStore/InMemoryCheckpointStore: correct for a single
// gateway instance, not for a multi-instance fleet (which would need a
// shared store — the AAI-036 Redis backend is the natural upgrade path,
// not built here since this story didn't ask for it).
export class RateLimiter {
  private readonly windowMs: number;
  private readonly max: number;
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(options: RateLimiterOptions) {
    if (options.windowMs <= 0 || options.max <= 0) {
      throw new AuthError('RateLimiter needs a positive windowMs and max.');
    }
    this.windowMs = options.windowMs;
    this.max = options.max;
  }

  /** Records one request against `key`'s current window, creating a fresh
   *  window if none is active or the previous one has elapsed. */
  consume(key: string): RateLimitResult {
    const now = Date.now();
    let window = this.windows.get(key);

    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, window);
    }

    window.count++;

    return {
      allowed: window.count <= this.max,
      remaining: Math.max(0, this.max - window.count),
      resetAt: new Date(window.resetAt),
    };
  }

  getDiagnostics(): RateLimiterDiagnostics {
    return { windowMs: this.windowMs, max: this.max, trackedKeys: this.windows.size };
  }
}
