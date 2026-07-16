import type { DistributedTransport, TransportHandler } from './DistributedTransport.ts';

// The narrow surface RedisDistributedTransport depends on instead of the
// `redis` package directly — same adapter idiom as core/caching/
// RedisClient.ts. node-redis needs a DEDICATED connection for subscriber
// mode (a client that has called SUBSCRIBE cannot issue other commands),
// so the composition root hands us two: one for PUBLISH, one already in
// subscriber mode. Message bodies cross the wire as JSON strings; this
// class owns that (de)serialization so callers only ever see structured
// messages, matching DistributedTransport's `unknown` payload contract.
export interface PubSubClient {
  publish(channel: string, payload: string): void | Promise<void>;
  /** Register the process-wide raw handler for a channel. Call once per
   *  channel — RedisDistributedTransport fans a channel's messages out to
   *  every locally-registered handler itself. */
  subscribe(channel: string, onMessage: (payload: string) => void): void | Promise<void>;
  unsubscribe(channel: string): void | Promise<void>;
}

// Production transport: real cross-process, cross-machine delivery over
// Redis pub/sub. Constructed exactly once, in core/bootstrap.ts (the
// same single-construction-site discipline as every other outbound
// network client — see core/architecture.test.ts), from an already-
// connected PubSubClient pair; this class itself never imports `redis`.
export class RedisDistributedTransport implements DistributedTransport {
  private readonly client: PubSubClient;
  private readonly localHandlers = new Map<string, Set<TransportHandler>>();

  constructor(client: PubSubClient) {
    this.client = client;
  }

  publish(channel: string, message: unknown): void {
    void this.client.publish(channel, JSON.stringify(message));
  }

  subscribe(channel: string, handler: TransportHandler): void {
    let handlers = this.localHandlers.get(channel);

    if (!handlers) {
      handlers = new Set();
      this.localHandlers.set(channel, handlers);
      // First local subscriber for this channel: open the one underlying
      // Redis subscription and fan every message out to whichever local
      // handlers are registered at delivery time.
      void this.client.subscribe(channel, (payload) => {
        const message = JSON.parse(payload) as unknown;
        for (const registered of [...(this.localHandlers.get(channel) ?? [])]) {
          registered(message);
        }
      });
    }

    handlers.add(handler);
  }

  unsubscribe(channel: string, handler: TransportHandler): void {
    const handlers = this.localHandlers.get(channel);
    if (!handlers) {
      return;
    }

    handlers.delete(handler);

    if (handlers.size === 0) {
      this.localHandlers.delete(channel);
      void this.client.unsubscribe(channel);
    }
  }
}
