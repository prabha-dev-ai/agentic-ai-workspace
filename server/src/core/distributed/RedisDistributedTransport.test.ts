import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { RedisDistributedTransport } from './RedisDistributedTransport.ts';
import type { PubSubClient } from './RedisDistributedTransport.ts';

// An in-memory stand-in for a real Redis connection pair — no network,
// same injected-fake idiom as RedisCache.test.ts's makeFakeRedisClient().
// Tracks how many times subscribe()/unsubscribe() were actually called
// against the "wire", so tests can assert RedisDistributedTransport only
// opens one real subscription per channel no matter how many local
// handlers register.
function makeFakePubSubClient() {
  const wireHandlers = new Map<string, (payload: string) => void>();
  let subscribeCalls = 0;
  let unsubscribeCalls = 0;

  const client: PubSubClient = {
    publish(channel, payload) {
      wireHandlers.get(channel)?.(payload);
    },
    subscribe(channel, onMessage) {
      subscribeCalls++;
      wireHandlers.set(channel, onMessage);
    },
    unsubscribe(channel) {
      unsubscribeCalls++;
      wireHandlers.delete(channel);
    },
  };

  return {
    client,
    get subscribeCalls() {
      return subscribeCalls;
    },
    get unsubscribeCalls() {
      return unsubscribeCalls;
    },
  };
}

describe('RedisDistributedTransport', () => {
  test('round-trips a structured message through JSON', () => {
    const fake = makeFakePubSubClient();
    const transport = new RedisDistributedTransport(fake.client);

    const received: unknown[] = [];
    transport.subscribe('chan', (message) => received.push(message));
    transport.publish('chan', { hello: 'world', n: 1 });

    assert.deepEqual(received, [{ hello: 'world', n: 1 }]);
  });

  test('opens exactly one real subscription per channel no matter how many local handlers register', () => {
    const fake = makeFakePubSubClient();
    const transport = new RedisDistributedTransport(fake.client);

    const receivedA: unknown[] = [];
    const receivedB: unknown[] = [];
    transport.subscribe('chan', (m) => receivedA.push(m));
    transport.subscribe('chan', (m) => receivedB.push(m));

    transport.publish('chan', 'ping');

    assert.equal(fake.subscribeCalls, 1);
    assert.deepEqual(receivedA, ['ping']);
    assert.deepEqual(receivedB, ['ping']);
  });

  test('unsubscribe removes only that handler; the wire subscription stays open for the rest', () => {
    const fake = makeFakePubSubClient();
    const transport = new RedisDistributedTransport(fake.client);

    const receivedA: unknown[] = [];
    const receivedB: unknown[] = [];
    const handlerA = (m: unknown) => receivedA.push(m);
    transport.subscribe('chan', handlerA);
    transport.subscribe('chan', (m) => receivedB.push(m));

    transport.unsubscribe('chan', handlerA);
    transport.publish('chan', 'ping');

    assert.equal(fake.unsubscribeCalls, 0, 'a sibling handler is still registered');
    assert.deepEqual(receivedA, []);
    assert.deepEqual(receivedB, ['ping']);
  });

  test('unsubscribing the last local handler closes the real wire subscription', () => {
    const fake = makeFakePubSubClient();
    const transport = new RedisDistributedTransport(fake.client);

    const handler = (_m: unknown) => {};
    transport.subscribe('chan', handler);
    transport.unsubscribe('chan', handler);

    assert.equal(fake.unsubscribeCalls, 1);
  });
});
