import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
// Importing via the barrel on purpose: tests exercise the same public
// surface plugins will use, so a broken export fails here.
import {
  PluginRegistry,
  PluginCapability,
  PluginError,
  DuplicatePluginError,
  PluginNotFoundError,
  PluginValidationError,
} from './index.ts';
import type { AgentPlugin, PluginMetadata, ToolProvider } from './index.ts';

function makePlugin(
  id: string,
  overrides: Partial<PluginMetadata> = {},
  hooks: { onRegister?: () => void; onDispose?: () => void } = {},
): AgentPlugin {
  return {
    metadata: {
      id,
      name: `Plugin ${id}`,
      version: '1.0.0',
      description: 'test plugin',
      author: 'tests',
      capabilities: [],
      ...overrides,
    },
    register() {
      hooks.onRegister?.();
    },
    dispose() {
      hooks.onDispose?.();
    },
  };
}

describe('metadata validation', () => {
  test('rejects empty id, name, and malformed versions', () => {
    const registry = new PluginRegistry();

    assert.throws(() => registry.register(makePlugin('')), PluginValidationError);
    assert.throws(
      () => registry.register(makePlugin('core.x', { name: ' ' })),
      /metadata\.name/,
    );
    assert.throws(
      () => registry.register(makePlugin('core.x', { version: 'one' })),
      /not a valid semver version/,
    );
    assert.throws(
      () => registry.register(makePlugin('core.x', { minimumFrameworkVersion: 'latest' })),
      /minimumFrameworkVersion/,
    );
  });

  test('accepts full metadata including optional fields', () => {
    const registry = new PluginRegistry();

    registry.register(
      makePlugin('core.full', {
        homepage: 'https://example.com',
        license: 'MIT',
        minimumFrameworkVersion: '1.0.0',
        version: '2.1.0-beta.1',
        capabilities: [PluginCapability.ToolProvider],
      }),
    );

    assert.equal(registry.exists('core.full'), true);
  });

  test('rejects unknown capability declarations', () => {
    const registry = new PluginRegistry();
    const bogus = makePlugin('core.z', {
      capabilities: ['time-travel' as PluginCapability],
    });

    assert.throws(() => registry.register(bogus), /unknown capability "time-travel"/);
  });

  test('validation errors carry the plugin id and inherit PluginError', () => {
    const registry = new PluginRegistry();

    try {
      registry.register(makePlugin('core.bad', { version: 'x' }));
      assert.fail('should have thrown');
    } catch (error) {
      assert.ok(error instanceof PluginValidationError);
      assert.ok(error instanceof PluginError);
      assert.equal((error as PluginValidationError).pluginId, 'core.bad');
    }
  });
});

describe('registration and removal', () => {
  test('register/exists/get round trip', () => {
    const registry = new PluginRegistry();
    const plugin = makePlugin('core.alpha');

    registry.register(plugin);

    assert.equal(registry.exists('core.alpha'), true);
    assert.equal(registry.get('core.alpha'), plugin);
  });

  test('duplicate ids throw DuplicatePluginError', () => {
    const registry = new PluginRegistry();
    registry.register(makePlugin('core.alpha'));

    assert.throws(
      () => registry.register(makePlugin('core.alpha')),
      DuplicatePluginError,
    );
  });

  test('get() of a missing plugin throws PluginNotFoundError', () => {
    const registry = new PluginRegistry();

    assert.throws(() => registry.get('core.ghost'), PluginNotFoundError);
  });

  test('unregister removes the plugin; unregistering twice throws', () => {
    const registry = new PluginRegistry();
    registry.register(makePlugin('core.alpha'));

    registry.unregister('core.alpha');
    assert.equal(registry.exists('core.alpha'), false);

    assert.throws(() => registry.unregister('core.alpha'), PluginNotFoundError);
  });

  test('the registry never invokes lifecycle hooks — that is the loader\'s job', () => {
    const registry = new PluginRegistry();
    let registerCalls = 0;
    let disposeCalls = 0;

    registry.register(
      makePlugin('core.alpha', {}, {
        onRegister: () => registerCalls++,
        onDispose: () => disposeCalls++,
      }),
    );
    registry.unregister('core.alpha');

    assert.equal(registerCalls, 0, 'register() hook must not run');
    assert.equal(disposeCalls, 0, 'dispose() hook must not run');
  });
});

describe('catalog queries', () => {
  test('list() returns all registered plugins', () => {
    const registry = new PluginRegistry();
    registry.register(makePlugin('core.a'));
    registry.register(makePlugin('core.b'));

    assert.deepEqual(registry.list().map((p) => p.metadata.id), ['core.a', 'core.b']);
  });

  test('listByCapability() filters on declared capabilities', () => {
    const registry = new PluginRegistry();
    registry.register(
      makePlugin('core.tools', { capabilities: [PluginCapability.ToolProvider] }),
    );
    registry.register(
      makePlugin('core.multi', {
        capabilities: [PluginCapability.ToolProvider, PluginCapability.AgentProvider],
      }),
    );
    registry.register(makePlugin('core.plain'));

    assert.deepEqual(
      registry.listByCapability(PluginCapability.ToolProvider).map((p) => p.metadata.id),
      ['core.tools', 'core.multi'],
    );
    assert.deepEqual(
      registry.listByCapability(PluginCapability.AgentProvider).map((p) => p.metadata.id),
      ['core.multi'],
    );
    assert.deepEqual(registry.listByCapability(PluginCapability.WorkflowProvider), []);
  });
});

describe('capability contracts', () => {
  test('a plugin can implement a provider interface alongside AgentPlugin', async () => {
    // Compile-time proof the contracts compose: a ToolProvider plugin.
    const plugin: AgentPlugin & ToolProvider = {
      metadata: {
        id: 'core.time',
        name: 'Time Tools',
        version: '1.0.0',
        description: 'provides time tools',
        author: 'tests',
        license: 'MIT',
        capabilities: [PluginCapability.ToolProvider],
      },
      register() {},
      getTools() {
        return [
          {
            definition: {
              type: 'function',
              function: {
                name: 'get_current_time',
                description: 'test',
                parameters: { type: 'object', properties: {} },
              },
            },
            execute: () => 'now',
          },
        ];
      },
    };

    const registry = new PluginRegistry();
    registry.register(plugin);

    const [provider] = registry.listByCapability(PluginCapability.ToolProvider);
    const tools = (provider as AgentPlugin & ToolProvider).getTools();
    assert.equal(tools.length, 1);
    assert.equal(await tools[0]?.execute({}), 'now');
  });
});
