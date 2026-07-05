import type OpenAI from 'openai';
import type { ServiceCollection } from '../container/ServiceCollection.ts';

// The capability model. Each capability is two halves of one contract:
// the identifier a plugin DECLARES in its metadata, and the provider
// interface it IMPLEMENTS to back that claim. Integration stories consume
// providers; this story only defines them.
//
// A const-object union instead of a TS enum: Node's type stripping
// cannot run enums.
export const PluginCapability = {
  ToolProvider: 'tool-provider',
  PromptProvider: 'prompt-provider',
  RetrieverProvider: 'retriever-provider',
  ServiceProvider: 'service-provider',
  EventSubscriber: 'event-subscriber',
} as const;

export type PluginCapability =
  (typeof PluginCapability)[keyof typeof PluginCapability];

/** A tool contribution: the model-facing definition + our-side executor. */
export interface ToolContribution {
  definition: OpenAI.Chat.Completions.ChatCompletionTool;
  execute(args: Record<string, unknown>): Promise<string> | string;
}

export interface ToolProvider {
  getTools(): ToolContribution[];
}

/** A named prompt fragment a plugin contributes (e.g. persona, rules). */
export interface PromptContribution {
  name: string;
  content: string;
}

export interface PromptProvider {
  getPrompts(): PromptContribution[];
}

/** A named retriever: query in, ranked context strings out. */
export interface RetrieverContribution {
  name: string;
  retrieve(query: string): Promise<string[]> | string[];
}

export interface RetrieverProvider {
  getRetrievers(): RetrieverContribution[];
}

/** Plugins may register services into the container at composition time. */
export interface ServiceProvider {
  registerServices(services: ServiceCollection): void;
}

/** Framework lifecycle/domain events. The event bus arrives later. */
export interface FrameworkEvent {
  type: string;
  payload?: unknown;
}

export interface EventSubscriber {
  onEvent(event: FrameworkEvent): void | Promise<void>;
}
