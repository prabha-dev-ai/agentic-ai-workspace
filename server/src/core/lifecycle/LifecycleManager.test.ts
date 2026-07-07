import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { LifecycleManager } from './LifecycleManager.ts';
import { AgentState } from './AgentState.ts';
import { EventBus } from '../events/EventBus.ts';
import { EventType } from '../events/EventType.ts';

describe('LifecycleManager: event mapping', () => {
  test('entering WaitingForUser publishes InteractionRequested', () => {
    const eventBus = new EventBus();
    const manager = new LifecycleManager({ eventBus });
    const lifecycle = manager.create();

    const published: string[] = [];
    eventBus.subscribe('*', (envelope) => {
      published.push(envelope.type);
    });

    lifecycle.transition(AgentState.Initializing);
    lifecycle.transition(AgentState.Ready);
    lifecycle.transition(AgentState.Executing);
    lifecycle.transition(AgentState.WaitingForUser);

    assert.equal(published.at(-1), EventType.InteractionRequested);
  });

  test('returning to Executing from WaitingForUser publishes InteractionResolved, not ExecutionStarted', () => {
    const eventBus = new EventBus();
    const manager = new LifecycleManager({ eventBus });
    const lifecycle = manager.create();

    lifecycle.transition(AgentState.Initializing);
    lifecycle.transition(AgentState.Ready);
    lifecycle.transition(AgentState.Executing);
    lifecycle.transition(AgentState.WaitingForUser);

    const published: string[] = [];
    eventBus.subscribe('*', (envelope) => {
      published.push(envelope.type);
    });
    lifecycle.transition(AgentState.Executing);

    assert.deepEqual(published, [EventType.InteractionResolved]);
  });

  test('a fresh Executing entry (not from a wait state) still publishes ExecutionStarted', () => {
    const eventBus = new EventBus();
    const manager = new LifecycleManager({ eventBus });
    const lifecycle = manager.create();

    lifecycle.transition(AgentState.Initializing);
    lifecycle.transition(AgentState.Ready);

    const published: string[] = [];
    eventBus.subscribe('*', (envelope) => {
      published.push(envelope.type);
    });
    lifecycle.transition(AgentState.Executing);

    assert.deepEqual(published, [EventType.ExecutionStarted]);
  });

  test('resuming from WaitingForTool still publishes ToolExecutionCompleted, unaffected by the WaitingForUser change', () => {
    const eventBus = new EventBus();
    const manager = new LifecycleManager({ eventBus });
    const lifecycle = manager.create();

    lifecycle.transition(AgentState.Initializing);
    lifecycle.transition(AgentState.Ready);
    lifecycle.transition(AgentState.Executing);
    lifecycle.transition(AgentState.WaitingForTool);

    const published: string[] = [];
    eventBus.subscribe('*', (envelope) => {
      published.push(envelope.type);
    });
    lifecycle.transition(AgentState.Executing);

    assert.deepEqual(published, [EventType.ToolExecutionCompleted]);
  });
});
