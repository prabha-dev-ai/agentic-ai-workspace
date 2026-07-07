import { randomUUID } from 'node:crypto';
import { WorkflowError } from './WorkflowError.ts';
import { WorkflowStatus } from './WorkflowStatus.ts';
import type { WorkflowDefinition } from './WorkflowDefinition.ts';
import type { WorkflowStepContext } from './WorkflowStepContext.ts';
import type { WorkflowStepResult } from './WorkflowStep.ts';
import type { WorkflowRun } from './WorkflowRun.ts';
import type { WorkflowEvent } from './WorkflowEvent.ts';
import { EventType } from '../events/EventType.ts';
import type { EventBus } from '../events/EventBus.ts';

export interface WorkflowObserver {
  readonly name: string;
  onEvent(event: WorkflowEvent): void;
}

export interface WorkflowRuntimeOptions {
  /** Runs retained for getRun()/listRuns(); oldest evicted first. Default 1000. */
  maxRuns?: number;
}

export interface WorkflowRuntimeDiagnostics {
  definitionsRegistered: number;
  /** Every run ever executed — a historical total, unaffected by retention eviction. */
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  /** Registered observer names, in registration order. */
  observers: string[];
  /** Observer onEvent() throws — isolated, counted, never propagated. */
  observerFailures: number;
}

// The workflow engine: components register a WorkflowDefinition once and
// run() it as many times as needed. Execution is sequential by default —
// step N+1 runs after step N — with conditional branching available
// per-step via WorkflowStep.next(). Every milestone (run/step
// started/completed/failed) fans out to observers and, when connected,
// the framework event bus — step traffic is milestone-grade here (a
// workflow has a handful of steps, not the high-frequency chunk volume a
// stream does), so unlike Streaming, every step event is published, not
// just the run-level ones.
export class WorkflowRuntime {
  private readonly definitions = new Map<string, WorkflowDefinition>();
  private readonly runs = new Map<string, WorkflowRun>();
  private readonly runOrder: string[] = [];
  private readonly observers = new Map<string, WorkflowObserver>();
  private readonly maxRuns: number;
  private eventBus: EventBus | undefined;

  private totalRuns = 0;
  private completedCount = 0;
  private failedCount = 0;
  private observerFailures = 0;

  constructor(options: WorkflowRuntimeOptions = {}) {
    this.maxRuns = options.maxRuns ?? 1000;
  }

  /** Register a workflow definition. Duplicate ids, empty ids/steps, and
   *  duplicate step ids within the definition all fail loudly. */
  defineWorkflow(definition: WorkflowDefinition): void {
    if (typeof definition.id !== 'string' || definition.id.trim() === '') {
      throw new WorkflowError('A workflow definition needs a non-empty id.');
    }
    if (this.definitions.has(definition.id)) {
      throw new WorkflowError(`A workflow definition "${definition.id}" is already registered.`);
    }
    if (definition.steps.length === 0) {
      throw new WorkflowError(`Workflow "${definition.id}" needs at least one step.`);
    }

    const seen = new Set<string>();
    for (const step of definition.steps) {
      if (typeof step.id !== 'string' || step.id.trim() === '') {
        throw new WorkflowError(`Workflow "${definition.id}" has a step without a non-empty id.`);
      }
      if (seen.has(step.id)) {
        throw new WorkflowError(`Workflow "${definition.id}" has duplicate step id "${step.id}".`);
      }
      seen.add(step.id);
    }

    this.definitions.set(definition.id, definition);
  }

  getDefinition(id: string): WorkflowDefinition | undefined {
    return this.definitions.get(id);
  }

  listDefinitions(): WorkflowDefinition[] {
    return [...this.definitions.values()];
  }

  /** Register a global observer. Duplicate names fail loudly — silent
   *  replacement is how "where did my workflow events go?" bugs are born. */
  addObserver(observer: WorkflowObserver): void {
    if (typeof observer.name !== 'string' || observer.name.trim() === '') {
      throw new WorkflowError('A workflow observer needs a non-empty name.');
    }
    if (this.observers.has(observer.name)) {
      throw new WorkflowError(`A workflow observer named "${observer.name}" is already registered.`);
    }
    this.observers.set(observer.name, observer);
  }

  removeObserver(name: string): void {
    if (!this.observers.delete(name)) {
      throw new WorkflowError(`No workflow observer named "${name}" is registered.`);
    }
  }

  /** Publish every workflow/step milestone onto the framework event bus,
   *  correlated by run id. */
  connectEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
  }

  /**
   * Run a registered workflow definition to completion. Never rejects for
   * a step failure — that's recorded as a Failed WorkflowRun, the same
   * way a Span records an error as status rather than throwing. Throws
   * synchronously only for misuse (an unknown definition id).
   */
  async run(definitionId: string, input: Record<string, unknown> = {}): Promise<WorkflowRun> {
    const definition = this.definitions.get(definitionId);
    if (!definition) {
      throw new WorkflowError(`No workflow definition "${definitionId}" is registered.`);
    }

    const runId = randomUUID();
    const startedAt = new Date();
    const results: Record<string, unknown> = {};
    const stepResults: WorkflowStepResult[] = [];
    const stepsById = new Map(definition.steps.map((step) => [step.id, step] as const));
    const indexById = new Map(definition.steps.map((step, index) => [step.id, index] as const));

    this.totalRuns++;
    this.dispatch({
      type: 'started',
      runId,
      definitionId: definition.id,
      definitionName: definition.name,
      timestamp: new Date(),
    });

    let status: WorkflowStatus = WorkflowStatus.Running;
    let error: string | undefined;
    let currentStepId: string | undefined = definition.steps[0]?.id;

    while (currentStepId !== undefined) {
      const step = stepsById.get(currentStepId);
      if (!step) {
        status = WorkflowStatus.Failed;
        error = `Workflow "${definition.id}" has no step "${currentStepId}".`;
        break;
      }

      const context: WorkflowStepContext = { input, results };
      const stepStartedAt = new Date();
      this.dispatch({ type: 'step-started', runId, stepId: step.id, timestamp: stepStartedAt });

      let output: unknown;
      try {
        output = await step.execute(context);
      } catch (stepError) {
        const message = describeError(stepError);
        const stepEndedAt = new Date();
        stepResults.push({
          stepId: step.id,
          status: 'failed',
          output: undefined,
          error: message,
          startedAt: stepStartedAt,
          endedAt: stepEndedAt,
          durationMs: stepEndedAt.getTime() - stepStartedAt.getTime(),
        });
        this.dispatch({ type: 'step-failed', runId, stepId: step.id, error: message, timestamp: stepEndedAt });
        status = WorkflowStatus.Failed;
        error = message;
        break;
      }

      const stepEndedAt = new Date();
      results[step.id] = output;
      stepResults.push({
        stepId: step.id,
        status: 'completed',
        output,
        error: undefined,
        startedAt: stepStartedAt,
        endedAt: stepEndedAt,
        durationMs: stepEndedAt.getTime() - stepStartedAt.getTime(),
      });
      this.dispatch({ type: 'step-completed', runId, stepId: step.id, output, timestamp: stepEndedAt });

      if (step.next) {
        currentStepId = step.next(context, output);
      } else {
        // Sequential fallthrough is relative to THIS step's own position
        // in the array, not an independently-advancing counter — a step
        // reached via a branch jump must still fall through to whatever
        // follows it, not to "one past wherever fallthrough last left off".
        const currentIndex = indexById.get(step.id)!;
        currentStepId = definition.steps[currentIndex + 1]?.id;
      }
    }

    if (status === WorkflowStatus.Running) {
      status = WorkflowStatus.Completed;
    }

    const endedAt = new Date();
    const durationMs = endedAt.getTime() - startedAt.getTime();

    if (status === WorkflowStatus.Completed) {
      this.completedCount++;
      this.dispatch({ type: 'completed', runId, durationMs, timestamp: endedAt });
    } else {
      this.failedCount++;
      this.dispatch({ type: 'failed', runId, error: error ?? 'unknown error', durationMs, timestamp: endedAt });
    }

    const run: WorkflowRun = {
      id: runId,
      definitionId: definition.id,
      definitionName: definition.name,
      status,
      startedAt,
      endedAt,
      durationMs,
      input,
      results,
      steps: stepResults,
      error,
    };

    this.retain(runId, run);
    return run;
  }

  getRun(id: string): WorkflowRun | undefined {
    return this.runs.get(id);
  }

  /** Every currently-retained run, oldest first. Subject to maxRuns eviction. */
  listRuns(): WorkflowRun[] {
    return this.runOrder.map((id) => this.runs.get(id)!);
  }

  getDiagnostics(): WorkflowRuntimeDiagnostics {
    return {
      definitionsRegistered: this.definitions.size,
      totalRuns: this.totalRuns,
      completedRuns: this.completedCount,
      failedRuns: this.failedCount,
      observers: [...this.observers.keys()],
      observerFailures: this.observerFailures,
    };
  }

  private retain(id: string, run: WorkflowRun): void {
    this.runs.set(id, run);
    this.runOrder.push(id);

    if (this.runOrder.length > this.maxRuns) {
      const evicted = this.runOrder.shift();
      if (evicted !== undefined) {
        this.runs.delete(evicted);
      }
    }
  }

  private dispatch(event: WorkflowEvent): void {
    for (const observer of this.observers.values()) {
      try {
        observer.onEvent(event);
      } catch {
        this.observerFailures++;
      }
    }

    this.publishToEventBus(event);
  }

  private publishToEventBus(event: WorkflowEvent): void {
    if (!this.eventBus) {
      return;
    }

    this.eventBus.publish({
      type: EVENT_TYPE_BY_WORKFLOW_EVENT[event.type],
      source: 'workflow-runtime',
      correlationId: event.runId,
      payload: event,
    });
  }
}

const EVENT_TYPE_BY_WORKFLOW_EVENT: Record<WorkflowEvent['type'], EventType> = {
  started: EventType.WorkflowStarted,
  'step-started': EventType.WorkflowStepStarted,
  'step-completed': EventType.WorkflowStepCompleted,
  'step-failed': EventType.WorkflowStepFailed,
  completed: EventType.WorkflowCompleted,
  failed: EventType.WorkflowFailed,
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
