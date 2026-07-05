import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentState } from './AgentState.ts';
import { AgentLifecycle, InvalidLifecycleTransitionError } from './AgentLifecycle.ts';
import { LifecycleManager } from './LifecycleManager.ts';

describe('lifecycle state machine', () => {
  test('starts in Created with the creation event on record', () => {
    const lifecycle = new AgentLifecycle('test-1');

    assert.equal(lifecycle.getState(), AgentState.Created);
    assert.equal(lifecycle.isTerminal(), false);

    const history = lifecycle.getHistory();
    assert.equal(history.length, 1);
    assert.deepEqual(
      { from: history[0]?.from, to: history[0]?.to },
      { from: null, to: AgentState.Created },
    );
    assert.ok(history[0]?.at instanceof Date);
  });

  test('walks the full happy path and records every event in order', () => {
    const lifecycle = new AgentLifecycle('test-2');
    const path = [
      AgentState.Initializing,
      AgentState.Ready,
      AgentState.Executing,
      AgentState.WaitingForTool,
      AgentState.Executing,
      AgentState.Completed,
      AgentState.Disposed,
    ];

    for (const state of path) {
      lifecycle.transition(state);
    }

    assert.equal(lifecycle.getState(), AgentState.Disposed);
    assert.deepEqual(
      lifecycle.getHistory().map((event) => event.to),
      [AgentState.Created, ...path],
    );

    const times = lifecycle.getHistory().map((event) => event.at.getTime());
    assert.deepEqual(times, [...times].sort((a, b) => a - b), 'timestamps monotonic');
  });

  test('rejects invalid transitions with the offending pair', () => {
    const lifecycle = new AgentLifecycle('test-3');

    try {
      lifecycle.transition(AgentState.Executing); // Created -> Executing
      assert.fail('should have thrown');
    } catch (error) {
      assert.ok(error instanceof InvalidLifecycleTransitionError);
      assert.equal(error.from, AgentState.Created);
      assert.equal(error.to, AgentState.Executing);
      assert.match(error.message, /Valid targets from "created"/);
    }

    assert.equal(lifecycle.getState(), AgentState.Created, 'state unchanged');
    assert.equal(lifecycle.getHistory().length, 1, 'no event recorded');
  });

  test('terminal states only allow disposal; Disposed allows nothing', () => {
    const lifecycle = new AgentLifecycle('test-4');
    lifecycle.transition(AgentState.Initializing);
    lifecycle.transition(AgentState.Ready);
    lifecycle.transition(AgentState.Executing);
    lifecycle.transition(AgentState.Completed);

    assert.equal(lifecycle.isTerminal(), true);
    assert.throws(
      () => lifecycle.transition(AgentState.Executing),
      InvalidLifecycleTransitionError,
    );

    lifecycle.transition(AgentState.Disposed);
    assert.throws(
      () => lifecycle.transition(AgentState.Created),
      InvalidLifecycleTransitionError,
    );
  });

  test('transition reasons are recorded', () => {
    const lifecycle = new AgentLifecycle('test-5');
    lifecycle.transition(AgentState.Initializing);
    lifecycle.transition(AgentState.Failed, 'provider exploded');

    const failure = lifecycle.getHistory().at(-1);
    assert.equal(failure?.reason, 'provider exploded');
  });

  test('duration freezes once a terminal state is reached', async () => {
    const lifecycle = new AgentLifecycle('test-6');
    lifecycle.transition(AgentState.Initializing);
    lifecycle.transition(AgentState.Failed, 'x');

    const frozen = lifecycle.getDuration();
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(lifecycle.getDuration(), frozen, 'terminal duration must not grow');
    assert.ok(frozen >= 0);
  });

  test('history is a copy — callers cannot rewrite the record', () => {
    const lifecycle = new AgentLifecycle('test-7');
    lifecycle.getHistory().pop();

    assert.equal(lifecycle.getHistory().length, 1);
  });
});

describe('lifecycle manager', () => {
  test('creates tracked instances with unique ids and lists them in order', () => {
    const manager = new LifecycleManager();
    const a = manager.create();
    const b = manager.create();

    assert.notEqual(a.id, b.id);
    assert.deepEqual(manager.list(), [a, b]);
    assert.equal(manager.get(a.id), a);
  });

  test('unknown lifecycle ids throw', () => {
    const manager = new LifecycleManager();

    assert.throws(() => manager.get('ghost'), /Unknown lifecycle "ghost"/);
  });
});
