import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PluginLoader,
  PluginRegistry,
  PluginCapability,
  PluginValidationError,
} from './index.ts';
import type { AgentPlugin, ToolProvider, ToolContribution } from './index.ts';

function makeTool(name: string, result = `${name}-result`): ToolContribution {
  return {
    definition: {
      type: 'function',
      function: {
        name,
        description: `test tool ${name}`,
        parameters: { type: 'object', properties: {} },
      },
    },
    execute: () => result,
  };
}

function makeToolPlugin(
  id: string,
  tools: ToolContribution[],
  hooks: { onRegister?: () => void; onDispose?: () => void } = {},
): AgentPlugin & ToolProvider {
  return {
    metadata: {
      id,
      name: `Plugin ${id}`,
      version: '1.0.0',
      description: 'test',
      author: 'tests',
      capabilities: [PluginCapability.ToolProvider],
    },
    register() {
      hooks.onRegister?.();
    },
    dispose() {
      hooks.onDispose?.();
    },
    getTools: () => tools,
  };
}

describe('plugin installation', () => {
  test('install registers the plugin and runs its register() hook', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    let hookRuns = 0;

    await loader.install(makeToolPlugin('core.a', [], { onRegister: () => hookRuns++ }));

    assert.equal(hookRuns, 1);
  });

  test('a failing register() hook rolls the plugin back completely', async () => {
    const registry = new PluginRegistry();
    const loader = new PluginLoader(registry);
    const plugin = makeToolPlugin('core.bad', [makeTool('bad_tool')]);
    plugin.register = () => {
      throw new Error('setup exploded');
    };

    await assert.rejects(() => loader.install(plugin), /setup exploded/);
    assert.equal(registry.exists('core.bad'), false, 'must not stay cataloged');
    assert.deepEqual(loader.getToolDefinitions(), [], 'must contribute no tools');
  });

  test('declaring tool-provider without implementing getTools() fails install', async () => {
    const registry = new PluginRegistry();
    const loader = new PluginLoader(registry);
    const liar = makeToolPlugin('core.liar', []);
    delete (liar as Partial<ToolProvider>).getTools;

    await assert.rejects(() => loader.install(liar), PluginValidationError);
    assert.equal(registry.exists('core.liar'), false);
  });
});

describe('tool harvesting', () => {
  test('aggregates tools across installed plugins', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    await loader.install(makeToolPlugin('core.a', [makeTool('a_one'), makeTool('a_two')]));
    await loader.install(makeToolPlugin('core.b', [makeTool('b_one')]));

    const names = loader
      .getToolDefinitions()
      .map((def) => (def.type === 'function' ? def.function.name : '?'));
    assert.deepEqual(names.sort(), ['a_one', 'a_two', 'b_one']);
  });

  test('tool collisions across plugins fail atomically, naming both plugins', async () => {
    const registry = new PluginRegistry();
    const loader = new PluginLoader(registry);
    await loader.install(makeToolPlugin('core.a', [makeTool('shared')]));

    await assert.rejects(
      () => loader.install(makeToolPlugin('core.b', [makeTool('fresh'), makeTool('shared')])),
      /"shared" from plugin "core\.b" collides .* plugin "core\.a"/,
    );

    assert.equal(registry.exists('core.b'), false, 'colliding plugin not installed');
    assert.equal(
      loader.getToolDefinitions().length,
      1,
      'no partial contribution from the failed install',
    );
    assert.equal(await loader.executeTool('shared'), 'shared-result', 'first plugin intact');
  });

  test('executes tools with the arguments the model sent', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    let received: unknown;
    const tool = makeTool('echo');
    tool.execute = (args) => {
      received = args;
      return 'ok';
    };
    await loader.install(makeToolPlugin('core.echo', [tool]));

    await loader.executeTool('echo', { city: 'Chennai' });
    assert.deepEqual(received, { city: 'Chennai' });
  });

  test('unknown tools throw instead of dispatching blindly', async () => {
    const loader = new PluginLoader(new PluginRegistry());

    await assert.rejects(
      () => loader.executeTool('hallucinated'),
      /No installed plugin provides a tool named "hallucinated"/,
    );
  });
});

describe('plugin uninstall', () => {
  test('uninstall runs dispose() and releases the plugin and its tools', async () => {
    const registry = new PluginRegistry();
    const loader = new PluginLoader(registry);
    let disposeRuns = 0;

    await loader.install(
      makeToolPlugin('core.a', [makeTool('a_tool')], { onDispose: () => disposeRuns++ }),
    );
    await loader.uninstall('core.a');

    assert.equal(disposeRuns, 1);
    assert.equal(registry.exists('core.a'), false);
    assert.deepEqual(loader.getToolDefinitions(), []);
  });
});
