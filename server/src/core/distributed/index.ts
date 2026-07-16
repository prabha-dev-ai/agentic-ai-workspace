// The distributed-execution API surface (AAI-039). Consumers import from
// this barrel only — the individual files are implementation layout.
//
// Layered entirely on top of the existing single-process primitives
// (AgentRegistry, MessageBus, DelegationManager, SupervisorAgent,
// EventBus, CheckpointManager, Observability/Tracing/Metrics) rather
// than replacing any of them:
//
//   - WorkerRegistry mirrors remote workers into the SAME AgentRegistry
//     SupervisorAgent/DistributedSupervisor already read, so routing
//     candidates include other nodes' workers with zero changes to
//     AgentRegistry itself.
//   - DistributedMessageBus subclasses MessageBus and is bound to the
//     SAME TOKENS.messageBus token (see core/bootstrap.ts) — the exact
//     "swap the concrete class, keep the interface" idiom already used
//     for TOKENS.vectorStore (Postgres vs. in-memory). DelegationManager
//     keeps calling messageBus.send() completely unmodified.
//   - HeartbeatWatchdog declares a worker lost by publishing the SAME
//     EventType.AgentFailed envelope AgentRegistry and SupervisorAgent
//     already listen for — failover is inherited, not reimplemented.
//   - RemoteTaskBridge turns "a remote worker finished its task" back
//     into the exact DelegationManager.complete()/fail() calls a local
//     worker already makes directly (see SupervisorAgent.test.ts).
//   - DistributedSupervisor is a new orchestrator (SupervisorAgent's
//     candidate-building has no seam for per-call capability filtering)
//     that adds capability-aware routing and retry, but still delegates
//     the actual worker tie-break to the existing RoutingStrategy
//     interface (LeastLoadedRoutingStrategy by default).
//   - DistributedEventBridge is generic cross-node EventBus propagation,
//     independent of the task-delegation plumbing above.

export { DistributedError } from './DistributedError.ts';
export type { WorkerDescriptor, WorkerRegistration } from './WorkerDescriptor.ts';
export type { DistributedTransport, TransportHandler } from './DistributedTransport.ts';
export {
  InMemoryDistributedTransport,
  InMemoryTransportHub,
} from './InMemoryDistributedTransport.ts';
export { RedisDistributedTransport } from './RedisDistributedTransport.ts';
export type { PubSubClient } from './RedisDistributedTransport.ts';
export {
  WORKER_REGISTRY_CHANNEL,
  EVENT_PROPAGATION_CHANNEL,
  nodeInboxChannel,
} from './DistributedProtocol.ts';
export { WorkerRegistry } from './WorkerRegistry.ts';
export type {
  WorkerRegistryOptions,
  WorkerHandle,
  WorkerRegistryDiagnostics,
} from './WorkerRegistry.ts';
export { WorkerHeartbeatSender } from './WorkerHeartbeatSender.ts';
export type { WorkerHeartbeatSenderOptions } from './WorkerHeartbeatSender.ts';
export { HeartbeatWatchdog } from './HeartbeatWatchdog.ts';
export type {
  HeartbeatWatchdogOptions,
  HeartbeatWatchdogDiagnostics,
} from './HeartbeatWatchdog.ts';
export { RemoteTaskBridge } from './RemoteTaskBridge.ts';
export type {
  RemoteTaskBridgeOptions,
  RemoteTaskBridgeDiagnostics,
} from './RemoteTaskBridge.ts';
export { DistributedMessageBus } from './DistributedMessageBus.ts';
export type { DistributedMessageBusOptions } from './DistributedMessageBus.ts';
export { DistributedEventBridge } from './DistributedEventBridge.ts';
export type {
  DistributedEventBridgeOptions,
  DistributedEventBridgeDiagnostics,
} from './DistributedEventBridge.ts';
export { DistributedSupervisor } from './DistributedSupervisor.ts';
export type {
  DistributedSupervisorOptions,
  DistributedWorkRequest,
  DistributedSupervisorDiagnostics,
} from './DistributedSupervisor.ts';
