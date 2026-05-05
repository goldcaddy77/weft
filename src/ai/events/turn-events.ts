import type { Message } from '../agent/types.ts';

/**
 * Fired at the beginning of each LLM turn within an agent loop, before the
 * provider call is made. Use this to observe turn sequencing, log model
 * selection, or track conversation growth over time.
 *
 * @example Log every turn start
 * ```ts
 * import { AgentTurnStartedEvent } from 'weft';
 *
 * const target = new EventTarget();
 *
 * target.addEventListener(AgentTurnStartedEvent.type, (e) => {
 *   const event = e as AgentTurnStartedEvent;
 *   console.log(`Turn ${event.turnIndex} started — model: ${event.model}, messages: ${event.conversationLength}`);
 * });
 * ```
 */
export class AgentTurnStartedEvent extends Event {
  static readonly type = 'agent:turn:started' as const;
  readonly workflowId: string;
  readonly agentId: string;
  readonly turnIndex: number;
  readonly model: string;
  readonly inputTokenEstimate: number;
  readonly conversationLength: number;

  constructor(
    workflowId: string,
    agentId: string,
    turnIndex: number,
    model: string,
    inputTokenEstimate: number,
    conversationLength: number,
  ) {
    super(AgentTurnStartedEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.turnIndex = turnIndex;
    this.model = model;
    this.inputTokenEstimate = inputTokenEstimate;
    this.conversationLength = conversationLength;
  }
}

/**
 * Fired after each LLM turn completes. Carries the model name, raw token
 * usage, wall-clock duration, tool-call count, and a size-bounded snapshot
 * of the conversation. Cost is the caller's concern post-shrinkage —
 * subscribers compute it from `inputTokens` / `outputTokens` against
 * whatever pricing they care about.
 *
 * @example Log per-turn duration and tool-call count
 * ```ts
 * import { AgentTurnCompletedEvent } from 'weft';
 *
 * const target = new EventTarget();
 *
 * target.addEventListener(AgentTurnCompletedEvent.type, (e) => {
 *   const event = e as AgentTurnCompletedEvent;
 *   console.log(
 *     `Turn ${event.turnIndex} (${event.model}): ${event.duration}ms, ${event.toolCallCount} tools`,
 *   );
 * });
 * ```
 */
export class AgentTurnCompletedEvent extends Event {
  static readonly type = 'agent:turn:completed' as const;
  readonly workflowId: string;
  readonly agentId: string;
  readonly turnIndex: number;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly duration: number;
  readonly toolCallCount: number;
  /**
   * Size-bounded snapshot of the agent's conversation at the moment this
   * turn completed. Truncated per the caps in `agent/event-message-snapshot.ts`
   * (`MAX_MESSAGE_CHARS`, `MAX_TOOL_RESULT_CHARS`, `MAX_SNAPSHOT_MESSAGES`)
   * so that long-running agents cannot blow up the event stream.
   */
  readonly messages: readonly Message[];

  constructor(
    workflowId: string,
    agentId: string,
    turnIndex: number,
    model: string,
    inputTokens: number,
    outputTokens: number,
    duration: number,
    toolCallCount: number,
    messages: readonly Message[],
  ) {
    super(AgentTurnCompletedEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.turnIndex = turnIndex;
    this.model = model;
    this.inputTokens = inputTokens;
    this.outputTokens = outputTokens;
    this.duration = duration;
    this.toolCallCount = toolCallCount;
    this.messages = messages;
  }
}
