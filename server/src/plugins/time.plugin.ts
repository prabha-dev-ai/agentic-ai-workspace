import { PluginCapability } from '../core/plugins/index.ts';
import { getCurrentTime } from '../tools/time.tool.ts';
import type { AgentPlugin, ToolProvider } from '../core/plugins/index.ts';

// The first built-in plugin: the time tool, contributed through the
// plugin pipeline instead of a hardcoded registry. The pure function
// stays in tools/ — the plugin is packaging, not implementation.
export const timePlugin: AgentPlugin & ToolProvider = {
  metadata: {
    id: 'core.time',
    name: 'Time Tools',
    version: '1.0.0',
    description: 'Provides the current local date and time.',
    author: 'Agentic AI Workspace',
    license: 'MIT',
    capabilities: [PluginCapability.ToolProvider],
  },

  register(context) {
    context.log('installed');
  },

  getTools() {
    return [
      {
        definition: {
          type: 'function',
          function: {
            name: 'get_current_time',
            description:
              'Returns the current local date and time, including the timezone. ' +
              'Use this whenever the user asks about the current time, date, or day.',
            parameters: {
              type: 'object',
              properties: {},
              required: [],
            },
          },
        },
        execute: () => getCurrentTime(),
      },
    ];
  },
};
