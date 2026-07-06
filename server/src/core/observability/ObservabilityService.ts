import { LogLevel, meetsThreshold } from './LogLevel.ts';
import type { LogEntry, LogFields } from './LogEntry.ts';
import type { LogSink } from './LogSink.ts';
import type { Logger } from './Logger.ts';
import type { EventBus } from '../events/EventBus.ts';

export class ObservabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface ObservabilityOptions {
  /** Entries below this level are counted but never dispatched. Default info. */
  minLevel?: LogLevel;
}

export interface ObservabilityDiagnostics {
  totalEntries: number;
  /** Entries below the threshold — counted, not dispatched. */
  suppressedEntries: number;
  entriesByLevel: Record<LogLevel, number>;
  /** Registered sink names, in registration order. */
  sinks: string[];
  /** Sink write() throws — isolated, counted, never propagated. */
  sinkFailures: number;
}

// The observability hub: components ask it for loggers, sinks receive
// what the loggers say, and the event bus bridge turns the framework's
// existing event stream into structured, correlated log entries.
export class ObservabilityService {
  private readonly minLevel: LogLevel;
  private readonly sinks = new Map<string, LogSink>();

  private totalEntries = 0;
  private suppressedEntries = 0;
  private sinkFailures = 0;
  private readonly entriesByLevel: Record<LogLevel, number> = {
    [LogLevel.Debug]: 0,
    [LogLevel.Info]: 0,
    [LogLevel.Warn]: 0,
    [LogLevel.Error]: 0,
  };

  constructor(options: ObservabilityOptions = {}) {
    this.minLevel = options.minLevel ?? LogLevel.Info;
  }

  /** Register a sink. Duplicate names fail loudly — silent replacement
   *  is how "where did my logs go?" bugs are born. */
  addSink(sink: LogSink): void {
    if (typeof sink.name !== 'string' || sink.name.trim() === '') {
      throw new ObservabilityError('A log sink needs a non-empty name.');
    }
    if (this.sinks.has(sink.name)) {
      throw new ObservabilityError(
        `A log sink named "${sink.name}" is already registered.`,
      );
    }
    this.sinks.set(sink.name, sink);
  }

  removeSink(name: string): void {
    if (!this.sinks.delete(name)) {
      throw new ObservabilityError(`No log sink named "${name}" is registered.`);
    }
  }

  getLogger(component: string): Logger {
    if (typeof component !== 'string' || component.trim() === '') {
      throw new ObservabilityError('A logger needs a non-empty component name.');
    }
    return this.createLogger(component, undefined);
  }

  /**
   * Bridge the framework's event stream into the log stream: every
   * published event becomes a DEBUG entry under 'events.<source>',
   * carrying the envelope's correlation id. Debug, deliberately —
   * event traffic is high-volume diagnostic detail; raising the
   * threshold to debug surfaces the full stream when needed.
   */
  observeEventBus(eventBus: EventBus): void {
    const logger = this.getLogger('events');

    eventBus.subscribe('*', (envelope) => {
      logger
        .child(envelope.source)
        .withCorrelation(envelope.correlationId)
        .debug(envelope.type, {
          eventId: envelope.eventId,
          payload: envelope.payload,
        });
    });
  }

  getDiagnostics(): ObservabilityDiagnostics {
    return {
      totalEntries: this.totalEntries,
      suppressedEntries: this.suppressedEntries,
      entriesByLevel: { ...this.entriesByLevel },
      sinks: [...this.sinks.keys()],
      sinkFailures: this.sinkFailures,
    };
  }

  private createLogger(
    component: string,
    correlationId: string | undefined,
  ): Logger {
    const dispatch = (level: LogLevel, message: string, fields?: LogFields) =>
      this.dispatch(level, component, correlationId, message, fields);

    return {
      component,
      correlationId,
      debug: (message, fields) => dispatch(LogLevel.Debug, message, fields),
      info: (message, fields) => dispatch(LogLevel.Info, message, fields),
      warn: (message, fields) => dispatch(LogLevel.Warn, message, fields),
      error: (message, fields) => dispatch(LogLevel.Error, message, fields),
      child: (subComponent) =>
        this.createLogger(`${component}.${subComponent}`, correlationId),
      withCorrelation: (id) => this.createLogger(component, id),
    };
  }

  private dispatch(
    level: LogLevel,
    component: string,
    correlationId: string | undefined,
    message: string,
    fields: LogFields | undefined,
  ): void {
    if (!meetsThreshold(level, this.minLevel)) {
      this.suppressedEntries++;
      return;
    }

    this.totalEntries++;
    this.entriesByLevel[level]++;

    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      component,
      message,
    };
    if (correlationId !== undefined) {
      entry.correlationId = correlationId;
    }
    if (fields !== undefined) {
      entry.fields = fields;
    }

    // Sink isolation, same philosophy as the event bus: one broken
    // sink must never break the app or starve the other sinks.
    for (const sink of this.sinks.values()) {
      try {
        sink.write(entry);
      } catch {
        this.sinkFailures++;
      }
    }
  }
}
