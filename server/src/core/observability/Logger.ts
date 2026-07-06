import type { LogFields } from './LogEntry.ts';

// The component-facing logging surface. Loggers are cheap, immutable
// views onto the ObservabilityService: child() narrows the component,
// withCorrelation() binds a flow id — neither mutates the parent.
export interface Logger {
  readonly component: string;
  readonly correlationId: string | undefined;

  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;

  /** A logger for a sub-component: 'planner' -> 'planner.llm'. */
  child(subComponent: string): Logger;

  /** A logger whose every entry carries this correlation id. */
  withCorrelation(correlationId: string): Logger;
}
