// Every framework event type. Dot-namespaced strings so future consumers
// can pattern-match on prefixes. A const-object union instead of a TS
// enum: Node's type stripping cannot run enums.
export const EventType = {
  AgentCreated: 'agent.created',
  AgentInitialized: 'agent.initialized',
  PlanningStarted: 'planning.started',
  ExecutionStarted: 'execution.started',
  ToolExecutionStarted: 'tool.execution.started',
  ToolExecutionCompleted: 'tool.execution.completed',
  ToolExecutionFailed: 'tool.execution.failed',
  AgentCompleted: 'agent.completed',
  AgentFailed: 'agent.failed',
  AgentCancelled: 'agent.cancelled',
  PluginInstalled: 'plugin.installed',
  PluginUninstalled: 'plugin.uninstalled',
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];
