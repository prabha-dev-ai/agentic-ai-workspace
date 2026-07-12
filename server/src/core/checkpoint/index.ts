// The checkpoint & recovery API surface. Consumers import from this
// barrel only — the individual files are implementation layout.

export { CheckpointError } from './CheckpointError.ts';
export type { Checkpoint } from './Checkpoint.ts';
export type { CheckpointStore, CheckpointStoreStats } from './CheckpointStore.ts';
export { InMemoryCheckpointStore } from './InMemoryCheckpointStore.ts';
export type { RecoveryResult } from './RecoveryResult.ts';
export { CheckpointManager } from './CheckpointManager.ts';
export type {
  CheckpointManagerOptions,
  CheckpointManagerDiagnostics,
} from './CheckpointManager.ts';
export type { AsyncCheckpointStore } from './AsyncCheckpointStore.ts';
export { PostgresCheckpointStore } from './PostgresCheckpointStore.ts';
export type { PostgresCheckpointStoreOptions } from './PostgresCheckpointStore.ts';
export { createAsyncCheckpointStorePlugin } from './AsyncCheckpointStorePlugin.ts';
