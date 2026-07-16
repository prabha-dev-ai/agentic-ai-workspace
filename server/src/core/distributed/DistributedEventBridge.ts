import { EVENT_PROPAGATION_CHANNEL } from './DistributedProtocol.ts';
import type { EventPropagationWireMessage } from './DistributedProtocol.ts';
import type { EventBus } from '../events/EventBus.ts';
import type { EventEnvelope } from '../events/EventEnvelope.ts';
import type { EventType } from '../events/EventType.ts';
import type { DistributedTransport } from './DistributedTransport.ts';
import type { Logger } from '../observability/index.ts';

export interface DistributedEventBridgeOptions {
  eventBus: EventBus;
  transport: DistributedTransport;
  nodeId: string;
  /** Which event types cross the wire. Default: every type. Narrow this
   *  on a chatty deployment (e.g. skip WorkerHeartbeat) without touching
   *  any publisher. */
  include?: readonly EventType[] | '*';
  logger?: Logger;
}

export interface DistributedEventBridgeDiagnostics {
  propagatedOut: number;
  propagatedIn: number;
}

// Distributed event propagation: mirrors this node's EventBus traffic
// onto every peer's EventBus, so a coordinator sees WorkerLost/
// AgentFailed/TaskFailed events for work happening anywhere in the
// cluster, not just locally. Generic on purpose — unlike
// DistributedMessageBus/RemoteTaskBridge (which exist specifically to
// make task delegation work across nodes), this bridge propagates
// EVERY included event type, so plugins, observability sinks, and
// tracing exporters on any node see the whole cluster's activity through
// the one EventBus subscription surface they already use.
//
// Loop prevention: the bridge subscribes to its OWN local EventBus('*')
// to publish outward, and to the shared transport channel to publish
// inbound events back onto the local EventBus — which would normally
// trigger its own outbound subscription again, forwarding the event
// straight back out and around forever. Guarded with a
// "type:correlationId currently being injected" set, bracketing exactly
// the one eventBus.publish() call the bridge itself makes: since
// EventBus.publish() dispatches synchronously and the injected event's
// own (type, correlationId) key is unlikely to recur from an unrelated
// publish during that window, this suppresses the bridge's own echo
// while still forwarding any NEW event a handler reacts with (e.g.
// SupervisorAgent turning a propagated AgentFailed into a fresh
// TaskFailed) — a distinct (type, correlationId) pair, so it is not
// suppressed. Trade-off: two genuinely unrelated events sharing the
// exact same (type, correlationId) during that narrow window would
// wrongly suppress one — accepted as vanishingly unlikely, since
// correlationId defaults to a fresh random id per event.
export class DistributedEventBridge {
  private readonly eventBus: EventBus;
  private readonly transport: DistributedTransport;
  private readonly nodeId: string;
  private readonly include: readonly EventType[] | '*';
  private readonly logger: Logger | undefined;
  private readonly suppressing = new Set<string>();
  private propagatedOut = 0;
  private propagatedIn = 0;
  private started = false;

  private readonly outboundHandler = (envelope: EventEnvelope) => this.onLocalEvent(envelope);
  private readonly inboundHandler = (raw: unknown) =>
    this.onWireMessage(raw as EventPropagationWireMessage);

  constructor(options: DistributedEventBridgeOptions) {
    this.eventBus = options.eventBus;
    this.transport = options.transport;
    this.nodeId = options.nodeId;
    this.include = options.include ?? '*';
    this.logger = options.logger;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.eventBus.subscribe('*', this.outboundHandler);
    this.transport.subscribe(EVENT_PROPAGATION_CHANNEL, this.inboundHandler);
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.eventBus.unsubscribe('*', this.outboundHandler);
    this.transport.unsubscribe(EVENT_PROPAGATION_CHANNEL, this.inboundHandler);
  }

  getDiagnostics(): DistributedEventBridgeDiagnostics {
    return { propagatedOut: this.propagatedOut, propagatedIn: this.propagatedIn };
  }

  private onLocalEvent(envelope: EventEnvelope): void {
    const key = `${envelope.type}:${envelope.correlationId}`;
    if (this.suppressing.has(key)) {
      return;
    }
    if (this.include !== '*' && !this.include.includes(envelope.type)) {
      return;
    }

    this.propagatedOut++;
    this.transport.publish(EVENT_PROPAGATION_CHANNEL, {
      originNodeId: this.nodeId,
      type: envelope.type,
      source: envelope.source,
      correlationId: envelope.correlationId,
      payload: envelope.payload,
    } satisfies EventPropagationWireMessage);
  }

  private onWireMessage(message: EventPropagationWireMessage): void {
    if (message.originNodeId === this.nodeId) {
      return;
    }

    const key = `${message.type}:${message.correlationId}`;
    this.suppressing.add(key);

    try {
      this.eventBus.publish({
        type: message.type,
        source: message.source,
        correlationId: message.correlationId,
        payload: message.payload,
      });
      this.propagatedIn++;
    } catch (error) {
      this.logger?.warn('Failed to apply propagated event locally', {
        type: message.type,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.suppressing.delete(key);
    }
  }
}
