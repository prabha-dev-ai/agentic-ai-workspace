import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceCollection } from './ServiceCollection.ts';
import { createServiceToken } from './ServiceDescriptor.ts';
import type { Container } from './Container.ts';

// Small stand-in services for the tests.
interface Logger {
  log(message: string): void;
  readonly lines: string[];
}

interface Greeter {
  greet(name: string): string;
}

function createLogger(): Logger {
  const lines: string[] = [];
  return {
    lines,
    log(message: string) {
      lines.push(message);
    },
  };
}

describe('service tokens', () => {
  test('rejects empty names', () => {
    assert.throws(() => createServiceToken(''), /non-empty name/);
    assert.throws(() => createServiceToken('   '), /non-empty name/);
  });
});

describe('registration', () => {
  test('has() reflects registrations on the collection', () => {
    const services = new ServiceCollection();
    const token = createServiceToken<Logger>('logger');

    assert.equal(services.has(token), false);
    services.registerSingleton(token, createLogger);
    assert.equal(services.has(token), true);
  });

  test('duplicate registrations throw, regardless of lifetime', () => {
    const services = new ServiceCollection();
    const token = createServiceToken<Logger>('logger');
    services.registerSingleton(token, createLogger);

    assert.throws(() => services.registerSingleton(token, createLogger), /already registered/);
    assert.throws(() => services.registerTransient(token, createLogger), /already registered/);
  });

  test('registration is chainable', () => {
    const services = new ServiceCollection()
      .registerSingleton(createServiceToken<Logger>('logger'), createLogger)
      .registerTransient(createServiceToken<string>('id'), () => 'x');

    assert.ok(services instanceof ServiceCollection);
  });
});

describe('resolution', () => {
  test('get() returns the registered service, strongly typed', () => {
    const services = new ServiceCollection();
    const token = createServiceToken<Logger>('logger');
    services.registerSingleton(token, createLogger);

    const logger = services.build().get(token);
    logger.log('hello'); // compiles because get() returned Logger
    assert.deepEqual(logger.lines, ['hello']);
  });

  test('get() throws a descriptive error for missing services', () => {
    const container = new ServiceCollection().build();
    const missing = createServiceToken<Logger>('missing-service');

    assert.throws(
      () => container.get(missing),
      /No service registered for token "missing-service"/,
    );
  });

  test('resolve() returns undefined for missing services', () => {
    const container = new ServiceCollection().build();
    assert.equal(container.resolve(createServiceToken<Logger>('nope')), undefined);
  });

  test('factories receive the container and can resolve dependencies', () => {
    const services = new ServiceCollection();
    const loggerToken = createServiceToken<Logger>('logger');
    const greeterToken = createServiceToken<Greeter>('greeter');

    services.registerSingleton(loggerToken, createLogger);
    services.registerSingleton(greeterToken, (container: Container) => {
      const logger = container.get(loggerToken);
      return {
        greet(name: string) {
          logger.log(`greeted ${name}`);
          return `Hello, ${name}!`;
        },
      };
    });

    const container = services.build();
    assert.equal(container.get(greeterToken).greet('Ada'), 'Hello, Ada!');
    assert.deepEqual(container.get(loggerToken).lines, ['greeted Ada']);
  });
});

describe('lifetimes', () => {
  test('singletons are created lazily and exactly once', () => {
    const services = new ServiceCollection();
    const token = createServiceToken<Logger>('logger');
    let created = 0;

    services.registerSingleton(token, () => {
      created++;
      return createLogger();
    });

    const container = services.build();
    assert.equal(created, 0, 'must not construct before first get()');

    const first = container.get(token);
    const second = container.get(token);
    assert.equal(created, 1);
    assert.equal(first, second, 'singleton must be the same instance');
  });

  test('transients are created fresh on every resolution', () => {
    const services = new ServiceCollection();
    const token = createServiceToken<Logger>('logger');
    let created = 0;

    services.registerTransient(token, () => {
      created++;
      return createLogger();
    });

    const container = services.build();
    const first = container.get(token);
    const second = container.get(token);
    assert.equal(created, 2);
    assert.notEqual(first, second, 'transients must be distinct instances');
  });
});

describe('container isolation', () => {
  test('each build() gets its own singleton cache', () => {
    const services = new ServiceCollection();
    const token = createServiceToken<Logger>('logger');
    services.registerSingleton(token, createLogger);

    const a = services.build().get(token);
    const b = services.build().get(token);
    assert.notEqual(a, b, 'two containers must not share instances');
  });

  test('registrations after build() do not leak into built containers', () => {
    const services = new ServiceCollection();
    const container = services.build();

    const late = createServiceToken<string>('late');
    services.registerSingleton(late, () => 'too late');

    assert.equal(container.has(late), false);
    assert.throws(() => container.get(late), /No service registered/);
  });
});

describe('failure modes', () => {
  test('circular dependencies are reported as a readable chain', () => {
    const services = new ServiceCollection();
    const aToken = createServiceToken<string>('a');
    const bToken = createServiceToken<string>('b');

    services.registerSingleton(aToken, (c: Container) => c.get(bToken));
    services.registerSingleton(bToken, (c: Container) => c.get(aToken));

    assert.throws(
      () => services.build().get(aToken),
      /Circular dependency detected: a -> b -> a/,
    );
  });

  test('a factory that throws does not poison later resolutions', () => {
    const services = new ServiceCollection();
    const token = createServiceToken<string>('flaky');
    let attempts = 0;

    services.registerSingleton(token, () => {
      attempts++;
      if (attempts === 1) throw new Error('first attempt fails');
      return 'recovered';
    });

    const container = services.build();
    assert.throws(() => container.get(token), /first attempt fails/);
    assert.equal(container.get(token), 'recovered', 'retry must not hit a cached failure');
  });
});
