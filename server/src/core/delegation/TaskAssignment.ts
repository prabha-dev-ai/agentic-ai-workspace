// The structured payload of a "task.assignment" message — everything a
// worker agent needs to act on the work it finds in its mailbox, without
// calling back to the DelegationManager first.
export interface TaskAssignment {
  taskId: string;
  title: string;
  description: string;
  assignedBy: string;
  payload: unknown;
  correlationId: string;
}
