import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverPlugins, isAgentPlugin } from './index.ts';

// Discovery is tested against real fixture directories written at run
// time — the same dynamic-import path production uses.

const fixtureRoots: string[] = [];

function makeFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-discovery-'));
  fixtureRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of fixtureRoots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function pluginSource(id: string, exportName = 'plugin'): string {
  return `export const ${exportName} = {
    metadata: {
      id: '${id}',
      name: 'Plugin ${id}',
      version: '1.0.0',
      description: 'fixture',
      author: 'tests',
      capabilities: [],
    },
    register() {},
  };\n`;
}

describe('plugin discovery', () => {
  test('discovers plugins from *.plugin.ts files, sorted by filename', async () => {
    const dir = makeFixtureDir();
    writeFileSync(join(dir, 'zeta.plugin.ts'), pluginSource('test.zeta'));
    writeFileSync(join(dir, 'alpha.plugin.ts'), pluginSource('test.alpha'));

    const plugins = await discoverPlugins(dir);

    assert.deepEqual(
      plugins.map((p) => p.metadata.id),
      ['test.alpha', 'test.zeta'],
      'sorted filename order for deterministic installs',
    );
  });

  test('ignores files that do not follow the naming convention', async () => {
    const dir = makeFixtureDir();
    writeFileSync(join(dir, 'real.plugin.ts'), pluginSource('test.real'));
    writeFileSync(join(dir, 'helper.ts'), 'export const x = 1;\n');
    writeFileSync(join(dir, 'notes.md'), '# not code\n');
    mkdirSync(join(dir, 'subdir'));

    const plugins = await discoverPlugins(dir);

    assert.deepEqual(plugins.map((p) => p.metadata.id), ['test.real']);
  });

  test('collects multiple plugin exports from one module', async () => {
    const dir = makeFixtureDir();
    writeFileSync(
      join(dir, 'pair.plugin.ts'),
      pluginSource('test.one', 'first') + pluginSource('test.two', 'second'),
    );

    const plugins = await discoverPlugins(dir);

    assert.deepEqual(plugins.map((p) => p.metadata.id).sort(), ['test.one', 'test.two']);
  });

  test('a plugin-named file with no plugin export fails loudly', async () => {
    const dir = makeFixtureDir();
    writeFileSync(join(dir, 'empty.plugin.ts'), 'export const notAPlugin = 42;\n');

    await assert.rejects(
      () => discoverPlugins(dir),
      /"empty\.plugin\.ts" does not export anything shaped like an AgentPlugin/,
    );
  });

  test('a module that throws on import is reported with its filename', async () => {
    const dir = makeFixtureDir();
    writeFileSync(join(dir, 'broken.plugin.ts'), "throw new Error('module exploded');\n");

    await assert.rejects(
      () => discoverPlugins(dir),
      /Failed to load plugin module "broken\.plugin\.ts": module exploded/,
    );
  });
});

describe('isAgentPlugin', () => {
  test('accepts plugin-shaped values and rejects everything else', () => {
    assert.equal(
      isAgentPlugin({ metadata: { id: 'x' }, register() {} }),
      true,
    );
    assert.equal(isAgentPlugin(null), false);
    assert.equal(isAgentPlugin(42), false);
    assert.equal(isAgentPlugin({ metadata: { id: 42 }, register() {} }), false);
    assert.equal(isAgentPlugin({ metadata: { id: 'x' } }), false);
  });
});
