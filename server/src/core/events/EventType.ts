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
  MessageSent: 'message.sent',
  MessageDelivered: 'message.delivered',
  MessageFailed: 'message.failed',
  TaskCreated: 'task.created',
  TaskAssigned: 'task.assigned',
  TaskStarted: 'task.started',
  TaskCompleted: 'task.completed',
  TaskFailed: 'task.failed',
  TaskCancelled: 'task.cancelled',
  StreamStarted: 'stream.started',
  StreamCompleted: 'stream.completed',
  StreamFailed: 'stream.failed',
  StreamCancelled: 'stream.cancelled',
  InteractionRequested: 'interaction.requested',
  InteractionResolved: 'interaction.resolved',
  InteractionCancelled: 'interaction.cancelled',
  InteractionTimedOut: 'interaction.timedout',
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];
