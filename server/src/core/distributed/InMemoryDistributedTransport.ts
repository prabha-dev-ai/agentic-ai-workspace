import type { DistributedTransport, TransportHandler } from './DistributedTransport.ts';

// The "network" for the in-memory transport: a plain channel -> handler-
// set map. Multiple InMemoryDistributedTransport instances constructed
// over the SAME hub simulate separate nodes talking across a real
// network — the hub is the wire, each transport instance is one node's
// NIC. A hub-less transport (the default) is a single, isolated node:
// harmless in a non-distributed deployment, and exactly what lets
// TOKENS.distributedTransport be safely constructed even when nothing
// else is listening.
export class InMemoryTransportHub {
  private readonly channels = new Map<string, Set<TransportHandler>>();

  publish(channel: string, message: unknown): void {
    const handlers = this.channels.get(channel);
    if (!handlers) {
      return;
    }
    // Snapshot before iterating: a handler that unsubscribes mid-delivery
    // (e.g. a one-shot listener) must not skip a sibling handler or
    // throw a "mutated while iterating" surprise.
    for (const handler of [...handlers]) {
      handler(message);
    }
  }

  subscribe(channel: string, handler: TransportHandler): void {
    let handlers = this.channels.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.channels.set(channel, handlers);
    }
    handlers.add(handler);
  }

  unsubscribe(channel: string, handler: TransportHandler): void {
    this.channels.get(channel)?.delete(handler);
  }
}

// Zero-dependency default transport: delivers synchronously, in-process
// — no real network hop, the same reference-implementation trade-off as
// Mailbox's synchronous FIFO queue. Good enough to run and test the full
// distributed story (worker registration, heartbeats, delegation, event
// propagation) across simulated nodes in one process or one test file,
// without requiring a live Redis server. Swap in
// RedisDistributedTransport (see RedisDistributedTransport.ts) for an
// actual cross-process/cross-machine deployment.
export class InMemoryDistributedTransport implements DistributedTransport {
  private readonly hub: InMemoryTransportHub;

  constructor(hub: InMemoryTransportHub = new InMemoryTransportHub()) {
    this.hub = hub;
  }

  publish(channel: string, message: unknown): void {
    this.hub.publish(channel, message);
  }

  subscribe(channel: string, handler: TransportHandler): void {
    this.hub.subscribe(channel, handler);
  }

  unsubscribe(channel: string, handler: TransportHandler): void {
    this.hub.unsubscribe(channel, handler);
  }
}
