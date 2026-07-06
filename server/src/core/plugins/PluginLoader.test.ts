import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PluginLoader,
  PluginRegistry,
  PluginCapability,
  PluginNotFoundError,
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

describe('generalized contributions', () => {
  test('harvests prompts, retrievers, workflows and agents', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    const plugin: AgentPlugin & Record<string, unknown> = {
      metadata: {
        id: 'core.kitchen-sink',
        name: 'Kitchen Sink',
        version: '1.0.0',
        description: 'contributes everything',
        author: 'tests',
        capabilities: [
          PluginCapability.PromptProvider,
          PluginCapability.RetrieverProvider,
          PluginCapability.WorkflowProvider,
          PluginCapability.AgentProvider,
        ],
      },
      register() {},
      getPrompts: () => [{ name: 'pirate', content: 'Talk like a pirate.' }],
      getRetrievers: () => [{ name: 'docs', retrieve: () => ['result'] }],
      getWorkflows: () => [
        { name: 'triage', description: 'triage flow', steps: [{ id: 1, description: 'read' }] },
      ],
      getAgents: () => [
        { name: 'reviewer', description: 'reviews code', systemPrompt: 'Review.' },
      ],
    };

    await loader.install(plugin);

    assert.deepEqual(loader.getPrompts().map((p) => p.name), ['pirate']);
    assert.deepEqual(loader.getRetrievers().map((r) => r.name), ['docs']);
    assert.deepEqual(loader.getWorkflows().map((w) => w.name), ['triage']);
    assert.deepEqual(loader.getAgents().map((a) => a.name), ['reviewer']);
  });

  test('declared-but-unimplemented fails uniformly for every capability', async () => {
    const registry = new PluginRegistry();
    const loader = new PluginLoader(registry);
    const liar: AgentPlugin = {
      metadata: {
        id: 'core.liar',
        name: 'Liar',
        version: '1.0.0',
        description: 'claims without implementing',
        author: 'tests',
        capabilities: [PluginCapability.PromptProvider],
      },
      register() {},
    };

    await assert.rejects(
      () => loader.install(liar),
      /declares prompt-provider but does not implement getPrompts\(\)/,
    );
    assert.equal(registry.exists('core.liar'), false);
  });

  test('named collisions apply across contribution kinds independently', async () => {
    const loader = new PluginLoader(new PluginRegistry());

    const promptPlugin = (id: string): AgentPlugin & Record<string, unknown> => ({
      metadata: {
        id, name: id, version: '1.0.0', description: 't', author: 'tests',
        capabilities: [PluginCapability.PromptProvider],
      },
      register() {},
      getPrompts: () => [{ name: 'persona', content: 'x' }],
    });

    await loader.install(promptPlugin('core.a'));

    await assert.rejects(
      () => loader.install(promptPlugin('core.b')),
      /Prompt "persona" from plugin "core\.b" collides .* plugin "core\.a"/,
    );
    assert.equal(loader.getPrompts().length, 1, 'first plugin intact');
  });

  test('failed install releases contributions of every kind', async () => {
    const registry = new PluginRegistry();
    const loader = new PluginLoader(registry);
    const plugin: AgentPlugin & Record<string, unknown> = {
      metadata: {
        id: 'core.halfway',
        name: 'Halfway',
        version: '1.0.0',
        description: 't',
        author: 'tests',
        capabilities: [PluginCapability.PromptProvider, PluginCapability.WorkflowProvider],
      },
      register() {},
      getPrompts: () => [{ name: 'ok-prompt', content: 'x' }],
      // Workflow with an empty name fails validation AFTER prompts committed.
      getWorkflows: () => [{ name: '', description: 'broken', steps: [] }],
    };

    await assert.rejects(() => loader.install(plugin), PluginValidationError);
    assert.equal(registry.exists('core.halfway'), false);
    assert.deepEqual(loader.getPrompts(), [], 'earlier-kind contributions rolled back');
  });
});

describe('installation diagnostics', () => {
  test('records every contribution type in the installation summary', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    const plugin: AgentPlugin & Record<string, unknown> = {
      metadata: {
        id: 'core.everything',
        name: 'Everything',
        version: '1.0.0',
        description: 't',
        author: 'tests',
        capabilities: [
          PluginCapability.ToolProvider,
          PluginCapability.PromptProvider,
          PluginCapability.RetrieverProvider,
          PluginCapability.WorkflowProvider,
          PluginCapability.AgentProvider,
          PluginCapability.MemoryProvider,
          PluginCapability.ServiceProvider,
          PluginCapability.EventSubscriber,
          PluginCapability.EmbeddingProvider,
        ],
      },
      register() {},
      getTools: () => [makeTool('t_tool')],
      getPrompts: () => [{ name: 'p_prompt', content: 'x' }],
      getRetrievers: () => [{ name: 'r_retriever', retrieve: () => [] }],
      getWorkflows: () => [{ name: 'w_workflow', description: 'x', steps: [] }],
      getAgents: () => [{ name: 'a_agent', description: 'x', systemPrompt: 'x' }],
      createMemoryStore: () => ({ append() {}, getHistory: () => [], clear() {} }),
      registerServices() {},
      onEvent() {},
      getEmbeddingProvider: () => ({
        model: { name: 'e-model' },
        embed: async () => [0],
        embedBatch: async () => [[0]],
      }),
    };

    const before = new Date();
    await loader.install(plugin);

    const installation = loader.getInstallation('core.everything');
    assert.deepEqual(installation.contributions, {
      tools: ['t_tool'],
      prompts: ['p_prompt'],
      retrievers: ['r_retriever'],
      workflows: ['w_workflow'],
      agents: ['a_agent'],
      providesMemory: true,
      providesServices: true,
      providesEmbeddings: true,
      subscribesToEvents: true,
    });
    assert.ok(installation.installedAt >= before, 'install time recorded');
    assert.equal(loader.listInstallations().length, 1);
  });

  test('diagnostics for unknown plugins throw PluginNotFoundError', () => {
    const loader = new PluginLoader(new PluginRegistry());

    assert.throws(() => loader.getInstallation('core.ghost'), PluginNotFoundError);
  });

  test('failed installs leave no installation record', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    const plugin = makeToolPlugin('core.bad', [makeTool('x')]);
    plugin.register = () => {
      throw new Error('boom');
    };

    await assert.rejects(() => loader.install(plugin));
    assert.deepEqual(loader.listInstallations(), []);
  });

  test('uninstall removes the installation record', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    await loader.install(makeToolPlugin('core.a', [makeTool('a_tool')]));

    await loader.uninstall('core.a');

    assert.deepEqual(loader.listInstallations(), []);
    assert.throws(() => loader.getInstallation('core.a'), PluginNotFoundError);
  });
});

describe('service provider integration', () => {
  test('registerServices lets plugins contribute container services', async () => {
    const { ServiceCollection } = await import('../container/ServiceCollection.ts');
    const { createServiceToken } = await import('../container/ServiceDescriptor.ts');

    const token = createServiceToken<string>('plugin-greeting');
    const loader = new PluginLoader(new PluginRegistry());
    const plugin: AgentPlugin & Record<string, unknown> = {
      metadata: {
        id: 'core.services',
        name: 'Service Plugin',
        version: '1.0.0',
        description: 't',
        author: 'tests',
        capabilities: [PluginCapability.ServiceProvider],
      },
      register() {},
      registerServices(services: InstanceType<typeof ServiceCollection>) {
        services.registerSingleton(token, () => 'hello from plugin');
      },
    };
    await loader.install(plugin);

    const services = new ServiceCollection();
    loader.registerServices(services);

    assert.equal(services.build().get(token), 'hello from plugin');
  });

  test('a throwing service provider reports the owning plugin', async () => {
    const { ServiceCollection } = await import('../container/ServiceCollection.ts');

    const loader = new PluginLoader(new PluginRegistry());
    const plugin: AgentPlugin & Record<string, unknown> = {
      metadata: {
        id: 'core.broken-services',
        name: 'Broken',
        version: '1.0.0',
        description: 't',
        author: 'tests',
        capabilities: [PluginCapability.ServiceProvider],
      },
      register() {},
      registerServices() {
        throw new Error('bad wiring');
      },
    };
    await loader.install(plugin);

    assert.throws(
      () => loader.registerServices(new ServiceCollection()),
      /Plugin "core\.broken-services" failed to register services: bad wiring/,
    );
  });
});

describe('event bus integration', () => {
  test('install and uninstall publish plugin events', async () => {
    const { EventBus } = await import('../events/EventBus.ts');
    const { EventType } = await import('../events/EventType.ts');

    const bus = new EventBus();
    const seen: { type: string; payload: unknown }[] = [];
    bus.subscribe('*', (envelope) => {
      seen.push({ type: envelope.type, payload: envelope.payload });
    });

    const loader = new PluginLoader(new PluginRegistry(), bus);
    await loader.install(makeToolPlugin('core.a', []));
    await loader.uninstall('core.a');

    assert.deepEqual(
      seen.map((event) => event.type),
      [EventType.PluginInstalled, EventType.PluginUninstalled],
    );
    assert.deepEqual(seen[0]?.payload, {
      pluginId: 'core.a',
      name: 'Plugin core.a',
      version: '1.0.0',
    });
  });

  test('a failed install publishes no event', async () => {
    const { EventBus } = await import('../events/EventBus.ts');

    const bus = new EventBus();
    let published = 0;
    bus.subscribe('*', () => {
      published++;
    });

    const loader = new PluginLoader(new PluginRegistry(), bus);
    const broken = makeToolPlugin('core.bad', []);
    broken.register = () => {
      throw new Error('boom');
    };

    await assert.rejects(() => loader.install(broken));
    assert.equal(published, 0);
  });

  test('EventSubscriber plugins receive framework events until uninstalled', async () => {
    const { EventBus } = await import('../events/EventBus.ts');
    const { EventType } = await import('../events/EventType.ts');

    const bus = new EventBus();
    const loader = new PluginLoader(new PluginRegistry(), bus);
    const received: string[] = [];

    const subscriberPlugin: AgentPlugin & Record<string, unknown> = {
      metadata: {
        id: 'core.watcher',
        name: 'Watcher',
        version: '1.0.0',
        description: 't',
        author: 'tests',
        capabilities: [PluginCapability.EventSubscriber],
      },
      register() {},
      onEvent: (event: { type: string }) => {
        received.push(event.type);
      },
    };

    await loader.install(subscriberPlugin);
    // The watcher sees its own installation (subscribed during harvest,
    // PluginInstalled published after) and later plugin installs.
    await loader.install(makeToolPlugin('core.other', []));

    assert.deepEqual(received, [EventType.PluginInstalled, EventType.PluginInstalled]);

    await loader.uninstall('core.watcher');
    await loader.install(makeToolPlugin('core.late', []));

    assert.equal(received.length, 2, 'unsubscribed after uninstall');
  });

  test('a throwing subscriber plugin is isolated by the bus', async () => {
    const { EventBus } = await import('../events/EventBus.ts');

    const bus = new EventBus();
    const loader = new PluginLoader(new PluginRegistry(), bus);

    const angry: AgentPlugin & Record<string, unknown> = {
      metadata: {
        id: 'core.angry',
        name: 'Angry',
        version: '1.0.0',
        description: 't',
        author: 'tests',
        capabilities: [PluginCapability.EventSubscriber],
      },
      register() {},
      onEvent: () => {
        throw new Error('subscriber tantrum');
      },
    };

    await loader.install(angry);
    // Its own PluginInstalled event already triggers the tantrum — and
    // must not break the install or the loader.
    await loader.install(makeToolPlugin('core.calm', []));

    assert.ok(loader.getToolDefinitions !== undefined);
    const failures = bus.getDiagnostics().handlerFailures;
    assert.ok(failures.length >= 1);
    assert.equal(failures[0]?.error, 'subscriber tantrum');
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
