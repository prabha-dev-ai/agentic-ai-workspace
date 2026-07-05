import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentPlugin } from './AgentPlugin.ts';

// Dynamic discovery: plugins are found by convention, not by import list.
// Any "*.plugin.ts" (or compiled "*.plugin.js") file in the plugin
// directory is loaded, and every export that is shaped like an
// AgentPlugin is collected. Adding a plugin = adding a file.

const PLUGIN_FILE_PATTERN = /\.plugin\.(ts|js)$/;

export async function discoverPlugins(directory: string): Promise<AgentPlugin[]> {
  // Sorted for deterministic install order — collision outcomes must be
  // reproducible across runs and machines.
  const files = readdirSync(directory)
    .filter((name) => PLUGIN_FILE_PATTERN.test(name) && !name.endsWith('.d.ts'))
    .sort();

  const plugins: AgentPlugin[] = [];

  for (const file of files) {
    const moduleUrl = pathToFileURL(join(directory, file)).href;
    let module: Record<string, unknown>;

    try {
      module = (await import(moduleUrl)) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `Failed to load plugin module "${file}": ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }

    const found = Object.values(module).filter(isAgentPlugin);

    // A file following the plugin naming convention but exporting no
    // plugin is always a mistake — fail loudly, never skip silently.
    if (found.length === 0) {
      throw new Error(
        `Plugin module "${file}" does not export anything shaped like an AgentPlugin.`,
      );
    }

    plugins.push(...found);
  }

  return plugins;
}

// Runtime shape check: discovery imports arbitrary modules, so TypeScript
// types prove nothing here. Deep metadata validation stays the loader's job.
export function isAgentPlugin(value: unknown): value is AgentPlugin {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as { metadata?: { id?: unknown }; register?: unknown };

  return (
    typeof candidate.metadata === 'object' &&
    candidate.metadata !== null &&
    typeof candidate.metadata.id === 'string' &&
    typeof candidate.register === 'function'
  );
}
