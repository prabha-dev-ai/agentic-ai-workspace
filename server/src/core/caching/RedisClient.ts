// The Redis access abstraction RedisCache depends on, instead of the
// concrete `redis` package — same narrow-structural-interface idiom as
// core/database/PgClient.ts, and the same reason: RedisCache should be
// testable without a real Redis server, and the ONE place that touches
// the real `redis` client is the composition root (core/bootstrap.ts) —
// the same single-construction-site discipline core/architecture.test.ts
// already enforces for the OpenAI client.
export interface RedisClient {
  get(key: string): Promise<string | null>;
  /** ttlMs, when given, expires the key after that many milliseconds
   *  (Redis PX semantics) — omit for no expiry. */
  set(key: string, value: string, options?: { ttlMs?: number }): Promise<void>;
  del(key: string): Promise<number>;
  exists(key: string): Promise<boolean>;
  /** Pattern matching (e.g. "prefix:*"). Reference-implementation trade-
   *  off, same spirit as InMemoryVectorStore's O(n) scan comment: KEYS is
   *  O(n) over the whole keyspace and blocks the Redis event loop while
   *  it runs — fine for a learning/reference cache, not for a
   *  high-throughput production keyspace (SCAN would be the fix). */
  keys(pattern: string): Promise<string[]>;
}
