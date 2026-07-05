import type OpenAI from 'openai';
import type { Plugin, PluginTool, ToolArguments } from './Plugin.ts';

// Aggregates plugin contributions into one validated catalog. The
// registry answers two questions: "which plugins are installed?" and
// "which tools exist, and who runs them?" — the agent loop will consume
// the second view once plugins are wired into bootstrap.
export class PluginRegistry {
  private readonly plugins = new Map<string, Plugin>();
  private readonly tools = new Map<string, { tool: PluginTool; pluginName: string }>();

  /**
   * Register a plugin and all its tool contributions. Validation is
   * all-or-nothing: if any tool is invalid or collides, NOTHING from the
   * plugin is registered — a partially installed plugin is corrupted state.
   */
  register(plugin: Plugin): void {
    if (plugin.name.trim() === '') {
      throw new Error('A plugin needs a non-empty name.');
    }

    if (plugin.version.trim() === '') {
      throw new Error(`Plugin "${plugin.name}" needs a version.`);
    }

    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already registered.`);
    }

    // Validate every contribution BEFORE committing any of them.
    const validated = plugin.tools.map((tool) => {
      const toolName = extractToolName(plugin.name, tool);
      const existing = this.tools.get(toolName);

      if (existing) {
        throw new Error(
          `Tool "${toolName}" from plugin "${plugin.name}" collides with ` +
            `the same tool from plugin "${existing.pluginName}".`,
        );
      }

      return { toolName, tool };
    });

    const names = validated.map((entry) => entry.toolName);
    if (new Set(names).size !== names.length) {
      throw new Error(
        `Plugin "${plugin.name}" contributes duplicate tool names.`,
      );
    }

    this.plugins.set(plugin.name, plugin);
    for (const { toolName, tool } of validated) {
      this.tools.set(toolName, { tool, pluginName: plugin.name });
    }
  }

  hasPlugin(name: string): boolean {
    return this.plugins.has(name);
  }

  getPlugins(): Plugin[] {
    return [...this.plugins.values()];
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /** Every contributed tool definition — the model-facing menu. */
  getToolDefinitions(): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return [...this.tools.values()].map((entry) => entry.tool.definition);
  }

  /** Dispatch a model-requested tool call to the owning plugin. */
  async executeTool(name: string, args: ToolArguments = {}): Promise<string> {
    const entry = this.tools.get(name);

    // Models can hallucinate tool names — never dispatch blindly.
    if (!entry) {
      throw new Error(`No plugin provides a tool named "${name}".`);
    }

    return entry.tool.execute(args);
  }
}

function extractToolName(pluginName: string, tool: PluginTool): string {
  if (tool.definition.type !== 'function') {
    throw new Error(
      `Plugin "${pluginName}" contributed a tool that is not a function tool.`,
    );
  }

  const name = tool.definition.function.name;

  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(
      `Plugin "${pluginName}" contributed a tool without a name.`,
    );
  }

  return name;
}
