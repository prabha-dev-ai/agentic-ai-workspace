import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthError } from './AuthError.ts';
import { RateLimiter } from './RateLimiter.ts';

describe('RateLimiter', () => {
  test('rejects a non-positive windowMs or max', () => {
    assert.throws(() => new RateLimiter({ windowMs: 0, max: 10 }), AuthError);
    assert.throws(() => new RateLimiter({ windowMs: 1000, max: 0 }), AuthError);
  });

  test('allows requests up to max, then rejects', () => {
    const limiter = new RateLimiter({ windowMs: 60_000, max: 2 });
    const first = limiter.consume('alice');
    const second = limiter.consume('alice');
    const third = limiter.consume('alice');

    assert.equal(first.allowed, true);
    assert.equal(first.remaining, 1);
    assert.equal(second.allowed, true);
    assert.equal(second.remaining, 0);
    assert.equal(third.allowed, false);
    assert.equal(third.remaining, 0);
  });

  test('tracks separate windows per key', () => {
    const limiter = new RateLimiter({ windowMs: 60_000, max: 1 });
    assert.equal(limiter.consume('alice').allowed, true);
    assert.equal(limiter.consume('bob').allowed, true);
    assert.equal(limiter.consume('alice').allowed, false);
  });

  test('a new window resets the count once the previous one has elapsed', async () => {
    const limiter = new RateLimiter({ windowMs: 10, max: 1 });
    assert.equal(limiter.consume('alice').allowed, true);
    assert.equal(limiter.consume('alice').allowed, false);

    await new Promise((resolve) => setTimeout(resolve, 15));

    assert.equal(limiter.consume('alice').allowed, true);
  });

  test('getDiagnostics reports configuration and tracked-key count', () => {
    const limiter = new RateLimiter({ windowMs: 60_000, max: 5 });
    limiter.consume('alice');
    limiter.consume('bob');
    assert.deepEqual(limiter.getDiagnostics(), { windowMs: 60_000, max: 5, trackedKeys: 2 });
  });
});
