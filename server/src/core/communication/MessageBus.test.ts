import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox } from './Mailbox.ts';
import { MessageBus } from './MessageBus.ts';
import { EventBus } from '../events/EventBus.ts';
import { EventType } from '../events/EventType.ts';
import type { MessageEnvelope } from './MessageEnvelope.ts';

describe('mailbox', () => {
  function envelopeFor(id: string): MessageEnvelope {
    return {
      message: {
        id,
        fromAgentId: 'a',
        toAgentId: 'b',
        messageType: 'test',
        correlationId: id,
        payload: null,
        createdAt: new Date(),
      },
      deliveredAt: new Date(),
    };
  }

  test('is strictly FIFO; peek does not remove; clear empties', () => {
    const mailbox = new Mailbox();
    mailbox.enqueue(envelopeFor('m1'));
    mailbox.enqueue(envelopeFor('m2'));
    mailbox.enqueue(envelopeFor('m3'));

    assert.equal(mailbox.size(), 3);
    assert.equal(mailbox.peek()?.message.id, 'm1');
    assert.equal(mailbox.size(), 3, 'peek must not remove');

    assert.equal(mailbox.dequeue()?.message.id, 'm1');
    assert.equal(mailbox.dequeue()?.message.id, 'm2');
    assert.equal(mailbox.size(), 1);

    mailbox.clear();
    assert.equal(mailbox.size(), 0);
    assert.equal(mailbox.dequeue(), undefined);
    assert.equal(mailbox.peek(), undefined);
  });
});

describe('sending', () => {
  test('send stamps the message and delivers it FIFO to the recipient', () => {
    const bus = new MessageBus();
    bus.registerMailbox('sender');
    const inbox = bus.registerMailbox('receiver');

    const message = bus.send({
      fromAgentId: 'sender',
      toAgentId: 'receiver',
      messageType: 'request',
      payload: { question: 'status?' },
    });

    assert.ok(message.id.length > 0);
    assert.equal(message.correlationId, message.id, 'self-correlated by default');
    assert.ok(message.createdAt instanceof Date);

    const envelope = inbox.dequeue();
    assert.equal(envelope?.message.id, message.id);
    assert.deepEqual(envelope?.message.payload, { question: 'status?' });
    assert.ok(envelope?.deliveredAt instanceof Date);
  });

  test('unknown recipients: counted, reported, thrown', () => {
    const eventBus = new EventBus();
    const types: string[] = [];
    eventBus.subscribe('*', (envelope) => {
      types.push(envelope.type);
    });

    const bus = new MessageBus(eventBus);
    bus.registerMailbox('sender');

    assert.throws(
      () =>
        bus.send({ fromAgentId: 'sender', toAgentId: 'ghost', messageType: 'request' }),
      /no mailbox registered/,
    );

    assert.deepEqual(types, [EventType.MessageSent, EventType.MessageFailed]);
    assert.equal(bus.getDiagnostics().undeliverable, 1);
    assert.equal(bus.getDiagnostics().delivered, 0);
  });

  test('successful sends publish message.sent then message.delivered, correlated', () => {
    const eventBus = new EventBus();
    const seen: { type: string; correlationId: string }[] = [];
    eventBus.subscribe('*', (envelope) => {
      seen.push({ type: envelope.type, correlationId: envelope.correlationId });
    });

    const bus = new MessageBus(eventBus);
    bus.registerMailbox('a');
    bus.registerMailbox('b');

    const message = bus.send({
      fromAgentId: 'a',
      toAgentId: 'b',
      messageType: 'request',
      correlationId: 'conversation-7',
    });

    assert.equal(message.correlationId, 'conversation-7');
    assert.deepEqual(seen, [
      { type: EventType.MessageSent, correlationId: 'conversation-7' },
      { type: EventType.MessageDelivered, correlationId: 'conversation-7' },
    ]);
  });
});

describe('broadcast', () => {
  test('reaches every mailbox except the sender, sharing one correlationId', () => {
    const bus = new MessageBus();
    const inboxA = bus.registerMailbox('a');
    const inboxB = bus.registerMailbox('b');
    const inboxC = bus.registerMailbox('c');

    const messages = bus.broadcast('a', 'announcement', { news: true });

    assert.equal(messages.length, 2);
    assert.equal(inboxA.size(), 0, 'sender does not receive its own broadcast');
    assert.equal(inboxB.size(), 1);
    assert.equal(inboxC.size(), 1);

    const ids = new Set(messages.map((m) => m.id));
    assert.equal(ids.size, 2, 'each recipient gets its own message id');
    assert.equal(
      messages[0]?.correlationId,
      messages[1]?.correlationId,
      'one correlation id ties the broadcast together',
    );
  });

  test('broadcasting to an empty room is fine', () => {
    const bus = new MessageBus();
    bus.registerMailbox('loner');

    assert.deepEqual(bus.broadcast('loner', 'hello'), []);
  });
});

describe('handlers and mailbox management', () => {
  test('push handlers are notified; the message still lands in the mailbox', () => {
    const bus = new MessageBus();
    bus.registerMailbox('sender');
    const pushed: string[] = [];
    const inbox = bus.registerMailbox('receiver', (envelope) => {
      pushed.push(envelope.message.messageType);
    });

    bus.send({ fromAgentId: 'sender', toAgentId: 'receiver', messageType: 'ping' });

    assert.deepEqual(pushed, ['ping']);
    assert.equal(inbox.size(), 1, 'pull remains the source of truth');
  });

  test('a throwing handler loses nothing', () => {
    const bus = new MessageBus();
    bus.registerMailbox('sender');
    const inbox = bus.registerMailbox('receiver', () => {
      throw new Error('handler tantrum');
    });

    const message = bus.send({
      fromAgentId: 'sender',
      toAgentId: 'receiver',
      messageType: 'ping',
    });

    assert.equal(inbox.dequeue()?.message.id, message.id);
    assert.equal(bus.getDiagnostics().delivered, 1);
  });

  test('duplicate and unknown mailbox operations fail loudly', () => {
    const bus = new MessageBus();
    bus.registerMailbox('a');

    assert.throws(() => bus.registerMailbox('a'), /already has a mailbox/);
    assert.throws(() => bus.registerMailbox(' '), /non-empty agent id/);
    assert.throws(() => bus.unregisterMailbox('ghost'), /has no mailbox/);
    assert.throws(() => bus.getMailbox('ghost'), /has no mailbox/);

    bus.unregisterMailbox('a');
    assert.equal(bus.hasMailbox('a'), false);
  });
});

describe('diagnostics', () => {
  test('reports counts, active mailboxes and queue sizes', () => {
    const bus = new MessageBus();
    bus.registerMailbox('a');
    bus.registerMailbox('b');

    bus.send({ fromAgentId: 'a', toAgentId: 'b', messageType: 'one' });
    bus.send({ fromAgentId: 'a', toAgentId: 'b', messageType: 'two' });
    assert.throws(() =>
      bus.send({ fromAgentId: 'a', toAgentId: 'ghost', messageType: 'three' }),
    );

    assert.deepEqual(bus.getDiagnostics(), {
      totalSent: 3,
      delivered: 2,
      undeliverable: 1,
      activeMailboxes: 2,
      queueSizes: { a: 0, b: 2 },
    });
  });
});

describe('agent registry integration', () => {
  test('registration provisions a mailbox; unregistration retires it', async () => {
    const { AgentRegistry } = await import('../agents/AgentRegistry.ts');

    const eventBus = new EventBus();
    const messageBus = new MessageBus(eventBus);
    const registry = new AgentRegistry(eventBus, messageBus);

    const alpha = registry.register({ id: 'alpha', name: 'Alpha', type: 'worker' });
    registry.register({ id: 'beta', name: 'Beta', type: 'worker' });

    assert.equal(messageBus.hasMailbox('alpha'), true);
    assert.equal(messageBus.hasMailbox('beta'), true);

    // Registered agents can message each other by registry id.
    messageBus.send({
      fromAgentId: 'alpha',
      toAgentId: 'beta',
      messageType: 'greeting',
      payload: 'hello beta',
    });
    assert.equal(messageBus.getMailbox('beta').dequeue()?.message.payload, 'hello beta');

    alpha.unregister();
    assert.equal(messageBus.hasMailbox('alpha'), false);
    assert.equal(messageBus.getDiagnostics().activeMailboxes, 1);
  });
});
