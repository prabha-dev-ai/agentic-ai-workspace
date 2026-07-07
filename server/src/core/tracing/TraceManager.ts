import { randomUUID } from 'node:crypto';
import { SpanStatus } from './SpanStatus.ts';
import type { Span, SpanAttributes, SpanData } from './Span.ts';
import type { Tracer, StartSpanOptions } from './Tracer.ts';
import type { SpanExporter } from './SpanExporter.ts';
import type { Trace } from './Trace.ts';
import type { TraceContext } from './TraceContext.ts';
import type { EventBus } from '../events/EventBus.ts';

export class TraceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface TraceManagerOptions {
  /** Finished traces retained for getTrace()/listTraces(); oldest evicted first. Default 1000. */
  maxTraces?: number;
}

export interface TraceManagerDiagnostics {
  totalSpans: number;
  /** Spans started but not yet ended. */
  openSpans: number;
  totalTraces: number;
  /** Registered exporter names, in registration order. */
  exporters: string[];
  /** Exporter export() throws — isolated, counted, never propagated. */
  exporterFailures: number;
}

interface TraceAccumulator {
  traceId: string;
  spans: SpanData[];
  rootSpanId: string | undefined;
  startTime: Date;
  endTime: Date | undefined;
}

// The tracing hub: components ask it for tracers, spans are timed
// automatically and assembled into traces by traceId, and every finished
// span fans out to every registered exporter. Mirrors ObservabilityService
// deliberately — same component-scoped-view pattern (getTracer/getLogger),
// same fan-out-with-isolation destination model (exporters/sinks), same
// plugin capability shape for contributed destinations.
export class TraceManager {
  private readonly exporters = new Map<string, SpanExporter>();
  private readonly traces = new Map<string, TraceAccumulator>();
  private readonly traceOrder: string[] = [];
  private readonly openSpanIds = new Set<string>();
  private readonly maxTraces: number;

  private totalSpans = 0;
  private exporterFailures = 0;

  constructor(options: TraceManagerOptions = {}) {
    this.maxTraces = options.maxTraces ?? 1000;
  }

  /** Register an exporter. Duplicate names fail loudly — silent replacement
   *  is how "where did my spans go?" bugs are born. */
  addExporter(exporter: SpanExporter): void {
    if (typeof exporter.name !== 'string' || exporter.name.trim() === '') {
      throw new TraceError('A span exporter needs a non-empty name.');
    }
    if (this.exporters.has(exporter.name)) {
      throw new TraceError(
        `A span exporter named "${exporter.name}" is already registered.`,
      );
    }
    this.exporters.set(exporter.name, exporter);
  }

  removeExporter(name: string): void {
    if (!this.exporters.delete(name)) {
      throw new TraceError(`No span exporter named "${name}" is registered.`);
    }
  }

  getTracer(component: string): Tracer {
    if (typeof component !== 'string' || component.trim() === '') {
      throw new TraceError('A tracer needs a non-empty component name.');
    }
    return this.createTracer(component);
  }

  /**
   * Bridge the framework's event stream into the trace stream: every
   * published event becomes a zero-duration span under 'events.<source>',
   * reusing the envelope's correlation id AS the trace id — and as a
   * virtual parent span id, so every event in the same flow lands as a
   * sibling under that flow instead of falsely claiming to be its own
   * root. This is what lets a TraceContext line up with the correlation
   * id already carried by logs (ObservabilityService.observeEventBus) and
   * events, without any component having to propagate one by hand.
   */
  observeEventBus(eventBus: EventBus): void {
    const tracer = this.getTracer('events');

    eventBus.subscribe('*', (envelope) => {
      const span = tracer.startSpan(envelope.type, {
        parent: { traceId: envelope.correlationId, spanId: envelope.correlationId },
        attributes: { eventId: envelope.eventId, source: envelope.source },
      });
      span.end(SpanStatus.Ok);
    });
  }

  getTrace(traceId: string): Trace | undefined {
    const trace = this.traces.get(traceId);
    return trace ? this.toTrace(trace) : undefined;
  }

  /** Every retained trace, oldest first. */
  listTraces(): Trace[] {
    return this.traceOrder.map((id) => this.toTrace(this.traces.get(id)!));
  }

  getDiagnostics(): TraceManagerDiagnostics {
    return {
      totalSpans: this.totalSpans,
      openSpans: this.openSpanIds.size,
      totalTraces: this.traces.size,
      exporters: [...this.exporters.keys()],
      exporterFailures: this.exporterFailures,
    };
  }

  private toTrace(trace: TraceAccumulator): Trace {
    return {
      traceId: trace.traceId,
      spans: [...trace.spans],
      rootSpanId: trace.rootSpanId,
      startTime: trace.startTime,
      endTime: trace.endTime,
      durationMs: trace.endTime
        ? trace.endTime.getTime() - trace.startTime.getTime()
        : undefined,
    };
  }

  private createTracer(component: string): Tracer {
    const startSpan = (name: string, options: StartSpanOptions = {}): Span =>
      this.startSpan(component, name, options);

    return {
      component,
      startSpan,
      withSpan: (name, fn, options) => {
        const span = startSpan(name, options);
        try {
          const result = fn(span);
          span.end(SpanStatus.Ok);
          return result;
        } catch (error) {
          span.end(SpanStatus.Error, describeError(error));
          throw error;
        }
      },
      withSpanAsync: async (name, fn, options) => {
        const span = startSpan(name, options);
        try {
          const result = await fn(span);
          span.end(SpanStatus.Ok);
          return result;
        } catch (error) {
          span.end(SpanStatus.Error, describeError(error));
          throw error;
        }
      },
      child: (subComponent) => this.createTracer(`${component}.${subComponent}`),
    };
  }

  private startSpan(
    component: string,
    name: string,
    options: StartSpanOptions,
  ): Span {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new TraceError('A span needs a non-empty name.');
    }

    const traceId = options.parent?.traceId ?? randomUUID();
    const spanId = randomUUID();
    const parentSpanId = options.parent?.spanId;
    const startTime = new Date();
    const attributes: SpanAttributes = { ...options.attributes };

    this.totalSpans++;
    this.openSpanIds.add(spanId);

    const manager = this;
    let ended = false;

    const span: Span = {
      traceId,
      spanId,
      parentSpanId,
      name,
      component,
      startTime,

      setAttribute(key, value) {
        attributes[key] = value;
      },
      setAttributes(more) {
        Object.assign(attributes, more);
      },
      context(): TraceContext {
        return { traceId, spanId };
      },
      startChild(childName, childAttributes) {
        return manager.startSpan(component, childName, {
          parent: { traceId, spanId },
          ...(childAttributes !== undefined && { attributes: childAttributes }),
        });
      },
      end(status = SpanStatus.Ok, error) {
        if (ended) {
          throw new TraceError(`Span "${spanId}" ("${name}") has already ended.`);
        }
        ended = true;
        manager.finishSpan({
          traceId,
          spanId,
          parentSpanId,
          name,
          component,
          startTime,
          attributes,
          status,
          error,
        });
      },
    };

    return span;
  }

  private finishSpan(
    partial: Omit<SpanData, 'endTime' | 'durationMs'>,
  ): void {
    this.openSpanIds.delete(partial.spanId);

    const endTime = new Date();
    const data: SpanData = {
      ...partial,
      endTime,
      durationMs: endTime.getTime() - partial.startTime.getTime(),
    };

    this.recordSpan(data);

    // Exporter isolation, same philosophy as the log sinks: one broken
    // exporter must never break the app or starve the other exporters.
    for (const exporter of this.exporters.values()) {
      try {
        exporter.export(data);
      } catch {
        this.exporterFailures++;
      }
    }
  }

  private recordSpan(data: SpanData): void {
    let trace = this.traces.get(data.traceId);

    if (!trace) {
      trace = {
        traceId: data.traceId,
        spans: [],
        rootSpanId: undefined,
        startTime: data.startTime,
        endTime: undefined,
      };
      this.traces.set(data.traceId, trace);
      this.traceOrder.push(data.traceId);

      if (this.traceOrder.length > this.maxTraces) {
        const evicted = this.traceOrder.shift();
        if (evicted !== undefined) {
          this.traces.delete(evicted);
        }
      }
    }

    trace.spans.push(data);
    if (data.parentSpanId === undefined) {
      trace.rootSpanId = data.spanId;
    }
    if (!trace.endTime || data.endTime > trace.endTime) {
      trace.endTime = data.endTime;
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
