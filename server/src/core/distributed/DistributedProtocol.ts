import type { AgentMessage } from '../communication/AgentMessage.ts';
import type { EventType } from '../events/EventType.ts';
import type { WorkerDescriptor } from './WorkerDescriptor.ts';

// The wire vocabulary every distributed component shares. Kept in one
// file so channel names and envelope shapes are defined exactly once —
// the same reasoning as EventType.ts being a single flat catalog rather
// than each module minting its own strings.

/** The one shared channel every node's worker registry announces on. */
export const WORKER_REGISTRY_CHANNEL = 'distributed.worker-registry';

/** One shared channel every node broadcasts framework events on. */
export const EVENT_PROPAGATION_CHANNEL = 'distributed.events';

/** Per-node inbound channel: forwarded task messages and task results
 *  addressed to workers/tasks this node owns. */
export function nodeInboxChannel(nodeId: string): string {
  return `distributed.inbox.${nodeId}`;
}

export type WorkerRegistryWireMessage =
  | { kind: 'announce'; originNodeId: string; worker: WorkerDescriptor }
  | { kind: 'remove'; originNodeId: string; workerId: string }
  | { kind: 'heartbeat'; originNodeId: string; workerId: string; at: string }
  | { kind: 'discover'; originNodeId: string };

export type NodeInboxWireMessage =
  | { kind: 'task-message'; originNodeId: string; message: AgentMessage }
  | {
      kind: 'task-result';
      originNodeId: string;
      taskId: string;
      outcome: 'started' | 'completed' | 'failed';
      output?: unknown;
      error?: string;
    };

export interface EventPropagationWireMessage {
  originNodeId: string;
  type: EventType;
  source: string;
  correlationId: string;
  payload: unknown;
}
