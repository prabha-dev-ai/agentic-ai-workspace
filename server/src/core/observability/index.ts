// The observability API surface. Consumers import from this barrel only —
// the individual files are implementation layout.

export { LogLevel, meetsThreshold } from './LogLevel.ts';
export type { LogEntry, LogFields } from './LogEntry.ts';
export type { Logger } from './Logger.ts';
export type { LogSink } from './LogSink.ts';
export { ConsoleLogSink, MemoryLogSink } from './LogSink.ts';
export {
  ObservabilityError,
  ObservabilityService,
} from './ObservabilityService.ts';
export type {
  ObservabilityDiagnostics,
  ObservabilityOptions,
} from './ObservabilityService.ts';
