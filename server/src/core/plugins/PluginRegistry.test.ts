import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PluginRegistry } from './PluginRegistry.ts';
import type { Plugin, PluginTool } from './Plugin.ts';

function makeTool(name: string, result = `${name}-result`): PluginTool {
  return {
    definition: {
      type: 'function',
      function: { name, description: `test tool ${name}`, parameters: { type: 'object', properties: {} } },
    },
    execute: () => result,
  };
}

function makePlugin(name: string, tools: PluginTool[]): Plugin {
  return { name, version: '1.0.0', description: `test plugin ${name}`, tools };
}

describe('plugin registration', () => {
  test('registers plugins and lists them', () => {
    const registry = new PluginRegistry();
    registry.register(makePlugin('alpha', [makeTool('alpha_tool')]));

    assert.equal(registry.hasPlugin('alpha'), true);
    assert.deepEqual(registry.getPlugins().map((p) => p.name), ['alpha']);
  });

  test('rejects invalid plugins', () => {
    const registry = new PluginRegistry();

    assert.throws(() => registry.register(makePlugin('', [])), /non-empty name/);
    assert.throws(
      () => registry.register({ ...makePlugin('x', []), version: ' ' }),
      /needs a version/,
    );
  });

  test('rejects duplicate plugin names', () => {
    const registry = new PluginRegistry();
    registry.register(makePlugin('alpha', []));

    assert.throws(() => registry.register(makePlugin('alpha', [])), /already registered/);
  });

  test('rejects tools without a function definition or name', () => {
    const registry = new PluginRegistry();
    const broken = makeTool('x');
    if (broken.definition.type === 'function') broken.definition.function.name = '';

    assert.throws(
      () => registry.register(makePlugin('bad', [broken])),
      /without a name/,
    );
  });
});

describe('tool aggregation', () => {
  test('aggregates tool definitions across plugins', () => {
    const registry = new PluginRegistry();
    registry.register(makePlugin('alpha', [makeTool('a_one'), makeTool('a_two')]));
    registry.register(makePlugin('beta', [makeTool('b_one')]));

    const names = registry
      .getToolDefinitions()
      .map((def) => (def.type === 'function' ? def.function.name : '?'));
    assert.deepEqual(names.sort(), ['a_one', 'a_two', 'b_one']);
  });

  test('tool collisions across plugins name both plugins', () => {
    const registry = new PluginRegistry();
    registry.register(makePlugin('alpha', [makeTool('shared_tool')]));

    assert.throws(
      () => registry.register(makePlugin('beta', [makeTool('shared_tool')])),
      /"shared_tool" from plugin "beta" collides .* plugin "alpha"/,
    );
  });

  test('registration is atomic: a colliding plugin contributes nothing', () => {
    const registry = new PluginRegistry();
    registry.register(makePlugin('alpha', [makeTool('taken')]));

    assert.throws(() =>
      registry.register(makePlugin('beta', [makeTool('fresh'), makeTool('taken')])),
    );

    assert.equal(registry.hasPlugin('beta'), false, 'plugin must not be installed');
    assert.equal(registry.hasTool('fresh'), false, 'no partial tool registration');
  });

  test('duplicate tool names within one plugin are rejected', () => {
    const registry = new PluginRegistry();

    assert.throws(
      () => registry.register(makePlugin('alpha', [makeTool('dup'), makeTool('dup')])),
      /duplicate tool names/,
    );
  });
});

describe('tool execution', () => {
  test('dispatches to the owning plugin, sync or async', async () => {
    const registry = new PluginRegistry();
    const asyncTool: PluginTool = {
      definition: {
        type: 'function',
        function: { name: 'async_tool', description: 'async', parameters: { type: 'object', properties: {} } },
      },
      execute: async () => 'async-result',
    };
    registry.register(makePlugin('alpha', [makeTool('sync_tool'), asyncTool]));

    assert.equal(await registry.executeTool('sync_tool'), 'sync_tool-result');
    assert.equal(await registry.executeTool('async_tool'), 'async-result');
  });

  test('receives the arguments the model sent', async () => {
    const registry = new PluginRegistry();
    let received: unknown;
    const tool: PluginTool = {
      definition: {
        type: 'function',
        function: { name: 'echo', description: 'echo', parameters: { type: 'object', properties: {} } },
      },
      execute: (args) => {
        received = args;
        return 'ok';
      },
    };
    registry.register(makePlugin('alpha', [tool]));

    await registry.executeTool('echo', { city: 'Chennai' });
    assert.deepEqual(received, { city: 'Chennai' });
  });

  test('unknown tools throw instead of dispatching blindly', async () => {
    const registry = new PluginRegistry();

    await assert.rejects(
      () => registry.executeTool('hallucinated_tool'),
      /No plugin provides a tool named "hallucinated_tool"/,
    );
  });
});
