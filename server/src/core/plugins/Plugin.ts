import type OpenAI from 'openai';

// Plugin contracts: what a plugin IS and what it may contribute. Plugins
// are data + functions, never framework internals — a plugin can be
// defined without importing anything but these contracts.

export type ToolArguments = Record<string, unknown>;

// The same dual view the tool registry established: a definition the
// MODEL sees, and an implementation OUR CODE runs on its behalf.
export interface PluginTool {
  /** OpenAI function-tool definition (the model's "menu" entry). */
  definition: OpenAI.Chat.Completions.ChatCompletionTool;
  /**
   * Executed when the model requests this tool. May be sync or async —
   * real plugin tools (search, databases) are usually async.
   */
  execute(args: ToolArguments): Promise<string> | string;
}

export interface Plugin {
  /** Unique identity, e.g. "core-time". */
  name: string;
  version: string;
  description: string;
  /** Tools this plugin contributes to agents. */
  tools: PluginTool[];
}
