export class AgentCheckpointSizeWarningEvent extends Event {
  static readonly type = 'agent:checkpoint-size-warning' as const;
  readonly workflowId: string;
  readonly agentId: string;
  readonly sizeBytes: number;
  readonly turnIndex: number;

  constructor(workflowId: string, agentId: string, sizeBytes: number, turnIndex: number) {
    super(AgentCheckpointSizeWarningEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.sizeBytes = sizeBytes;
    this.turnIndex = turnIndex;
  }
}

/**
 * Fired after an agent loop completes when the effect log replayed at least
 * one committed tool-call result. This occurs primarily during checkpoint
 * restores (the agent re-synthesizes a previously dispatched tool call and
 * the effect log short-circuits it), but may also fire when the model emits
 * the same tool call twice within a single run and the second invocation is
 * replayed from the committed record.
 *
 * @example Listen for checkpoint resume events on the engine event target
 * ```ts
 * import { AgentCheckpointResumedEvent } from 'weft';
 *
 * const target = new EventTarget();
 *
 * target.addEventListener(AgentCheckpointResumedEvent.type, (e) => {
 *   const event = e as AgentCheckpointResumedEvent;
 *   console.log(
 *     `Agent ${event.agentId} resumed: ${event.duplicatesPrevented} tool call(s) replayed.`,
 *   );
 * });
 * ```
 */
export class AgentCheckpointResumedEvent extends Event {
  static readonly type = 'agent:checkpoint:resumed' as const;
  readonly workflowId: string;
  readonly agentId: string;
  /** Number of tool calls replayed from the effect log rather than re-executed. */
  readonly duplicatesPrevented: number;

  constructor(workflowId: string, agentId: string, duplicatesPrevented: number) {
    super(AgentCheckpointResumedEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.duplicatesPrevented = duplicatesPrevented;
  }
}
