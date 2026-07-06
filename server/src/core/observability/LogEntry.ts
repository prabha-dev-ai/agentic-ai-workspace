import type { LogLevel } from './LogLevel.ts';

/** Structured context attached to a log entry — data, never prose. */
export type LogFields = Record<string, unknown>;

// One structured log entry. Structure over string interpolation: fields
// stay machine-readable, so entries can be filtered by component,
// correlated by id, and aggregated by level — none of which works once
// context has been mashed into the message text.
export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  /** Who is speaking, dot-namespaced: 'plugins.core.time', 'events'. */
  component: string;
  message: string;
  /** Ties entries across components to one flow (agent run, request). */
  correlationId?: string;
  fields?: LogFields;
}
