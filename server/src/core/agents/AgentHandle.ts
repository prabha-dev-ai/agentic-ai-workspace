import type { AgentDescriptor } from './AgentDescriptor.ts';

// What register() returns: a reference the holder can use to inspect or
// end its own registration without carrying the whole registry around.
export interface AgentHandle {
  readonly id: string;
  getDescriptor(): AgentDescriptor;
  unregister(): void;
}
