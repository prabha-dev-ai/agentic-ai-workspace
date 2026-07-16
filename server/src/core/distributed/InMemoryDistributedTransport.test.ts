import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryDistributedTransport,
  InMemoryTransportHub,
} from './InMemoryDistributedTransport.ts';

describe('InMemoryDistributedTransport', () => {
  test('delivers a published message to every subscriber on the same hub', () => {
    const hub = new InMemoryTransportHub();
    const a = new InMemoryDistributedTransport(hub);
    const b = new InMemoryDistributedTransport(hub);

    const received: unknown[] = [];
    b.subscribe('chan', (message) => received.push(message));

    a.publish('chan', { hello: 'world' });

    assert.deepEqual(received, [{ hello: 'world' }]);
  });

  test('a publisher subscribed to its own channel also receives its own message', () => {
    const hub = new InMemoryTransportHub();
    const a = new InMemoryDistributedTransport(hub);

    const received: unknown[] = [];
    a.subscribe('chan', (message) => received.push(message));
    a.publish('chan', 'ping');

    assert.deepEqual(received, ['ping']);
  });

  test('separate hubs do not cross-deliver', () => {
    const a = new InMemoryDistributedTransport();
    const b = new InMemoryDistributedTransport();

    const received: unknown[] = [];
    b.subscribe('chan', (message) => received.push(message));
    a.publish('chan', 'ping');

    assert.deepEqual(received, []);
  });

  test('unsubscribe stops further delivery to that handler only', () => {
    const hub = new InMemoryTransportHub();
    const a = new InMemoryDistributedTransport(hub);
    const b = new InMemoryDistributedTransport(hub);

    const receivedOne: unknown[] = [];
    const receivedTwo: unknown[] = [];
    const handlerOne = (message: unknown) => receivedOne.push(message);
    b.subscribe('chan', handlerOne);
    b.subscribe('chan', (message) => receivedTwo.push(message));

    b.unsubscribe('chan', handlerOne);
    a.publish('chan', 'ping');

    assert.deepEqual(receivedOne, []);
    assert.deepEqual(receivedTwo, ['ping']);
  });

  test('publishing to a channel with no subscribers is a no-op', () => {
    const transport = new InMemoryDistributedTransport();
    assert.doesNotThrow(() => transport.publish('nobody-listening', 'x'));
  });
});
