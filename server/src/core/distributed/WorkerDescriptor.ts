// What a node provides when registering a worker it hosts locally.
export interface WorkerRegistration {
  /** Optional explicit id — generated (via AgentRegistry) when omitted. */
  id?: string;
  name: string;
  /** Free-form skill tags, e.g. ["python", "gpu", "summarize"]. */
  capabilities?: string[];
  metadata?: Record<string, unknown>;
}

// The registry's record of one worker, local or remote. Mirrors
// AgentDescriptor's shape philosophy (id/name/state live there; this
// adds the distributed-specific facts: which node hosts it, what it can
// do, and when it was last heard from).
export interface WorkerDescriptor {
  id: string;
  nodeId: string;
  name: string;
  capabilities: string[];
  registeredAt: Date;
  lastHeartbeatAt: Date;
  metadata: Record<string, unknown>;
}
