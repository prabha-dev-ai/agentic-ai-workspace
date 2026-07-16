// The one abstraction every cross-node component in this module depends
// on instead of a concrete network client — the same narrow-structural-
// interface idiom as RedisClient/PgClient (core/caching, core/database):
// testable against an in-memory fake, with exactly one place (core/
// bootstrap.ts) ever touching a real network library.
//
// A channel is a named broadcast topic: publish() delivers to every
// handler currently subscribed to that channel, on every transport
// instance attached to the same underlying network (in-memory hub or
// real Redis pub/sub) — including, deliberately, the publisher's own
// subscriptions, the same as a real Redis `PUBLISH`/`SUBSCRIBE` pair.
// Callers that must not react to their own messages filter by an
// `originNodeId` field inside the payload, not by transport behavior.
export type TransportHandler = (message: unknown) => void;

export interface DistributedTransport {
  publish(channel: string, message: unknown): void;
  subscribe(channel: string, handler: TransportHandler): void;
  unsubscribe(channel: string, handler: TransportHandler): void;
}
