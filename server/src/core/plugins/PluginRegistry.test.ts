import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PluginRegistry } from './PluginRegistry.ts';
import { PluginCapability } from './PluginCapability.ts';
import type { AgentPlugin } from './AgentPlugin.ts';
import type { ToolProvider } from './PluginCapability.ts';

function makePlugin(
  id: string,
  capabilities: PluginCapability[] = [],
  onRegister?: () => void,
): AgentPlugin {
  return {
    metadata: {
      id,
      name: `Plugin ${id}`,
      version: '1.0.0',
      description: 'test plugin',
      author: 'tests',
      capabilities,
    },
    register() {
      onRegister?.();
    },
  };
}

describe('plugin registration', () => {
  test('registers and retrieves plugins by id', () => {
    const registry = new PluginRegistry();
    const plugin = makePlugin('core.alpha');

    registry.register(plugin);

    assert.equal(registry.get('core.alpha'), plugin);
    assert.equal(registry.get('core.missing'), undefined);
  });

  test('rejects duplicate plugin ids', () => {
    const registry = new PluginRegistry();
    registry.register(makePlugin('core.alpha'));

    assert.throws(
      () => registry.register(makePlugin('core.alpha')),
      /"core\.alpha" is already registered/,
    );
  });

  test('rejects invalid metadata with specific errors', () => {
    const registry = new PluginRegistry();

    assert.throws(() => registry.register(makePlugin('')), /non-empty metadata\.id/);

    const noName = makePlugin('core.x');
    noName.metadata.name = ' ';
    assert.throws(() => registry.register(noName), /needs a non-empty name/);

    const noVersion = makePlugin('core.y');
    noVersion.metadata.version = '';
    assert.throws(() => registry.register(noVersion), /needs a version/);
  });

  test('rejects unknown capability declarations', () => {
    const registry = new PluginRegistry();
    const bogus = makePlugin('core.z', ['time-travel' as PluginCapability]);

    assert.throws(
      () => registry.register(bogus),
      /unknown capability "time-travel"/,
    );
  });

  test('does NOT invoke the register() hook — that is the loader\'s job', () => {
    const registry = new PluginRegistry();
    let hookCalls = 0;

    registry.register(makePlugin('core.alpha', [], () => hookCalls++));

    assert.equal(hookCalls, 0, 'registry must stay a passive catalog');
  });
});

describe('catalog queries', () => {
  test('list() returns all registered plugins', () => {
    const registry = new PluginRegistry();
    registry.register(makePlugin('core.a'));
    registry.register(makePlugin('core.b'));

    assert.deepEqual(
      registry.list().map((p) => p.metadata.id),
      ['core.a', 'core.b'],
    );
  });

  test('listByCapability() filters on declared capabilities', () => {
    const registry = new PluginRegistry();
    registry.register(makePlugin('core.tools', [PluginCapability.ToolProvider]));
    registry.register(
      makePlugin('core.multi', [
        PluginCapability.ToolProvider,
        PluginCapability.PromptProvider,
      ]),
    );
    registry.register(makePlugin('core.plain'));

    assert.deepEqual(
      registry.listByCapability(PluginCapability.ToolProvider).map((p) => p.metadata.id),
      ['core.tools', 'core.multi'],
    );
    assert.deepEqual(
      registry.listByCapability(PluginCapability.PromptProvider).map((p) => p.metadata.id),
      ['core.multi'],
    );
    assert.deepEqual(registry.listByCapability(PluginCapability.EventSubscriber), []);
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
