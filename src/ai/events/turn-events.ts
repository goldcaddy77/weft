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
 * Fired after each LLM turn completes, carrying token usage, duration, tool
 * call count, and a snapshot of the conversation. Cost fields are retained as
 * zero-valued event fields until the event surface is narrowed further.
 *
 * @example Track cumulative cost across turns
 * ```ts
 * import { AgentTurnCompletedEvent } from 'weft';
 *
 * const target = new EventTarget();
 *
 * target.addEventListener(AgentTurnCompletedEvent.type, (e) => {
 *   const event = e as AgentTurnCompletedEvent;
 *   console.log(
 *     `Turn ${event.turnIndex}: ${event.cost.toFixed(4)} (cumulative: ${event.cumulativeCost.toFixed(4)})`,
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
  readonly selectedModel: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost: number;
  readonly cumulativeCost: number;
  readonly duration: number;
  readonly toolCallCount: number;
  readonly fallbackAttempts: number;
  readonly reasoningTrace: string | undefined;
  /**
   * Size-bounded snapshot of the agent's conversation at the moment this
   * turn completed. Truncated per the caps in `event-message-snapshot.ts`
   * (`MAX_MESSAGE_CHARS`, `MAX_TOOL_RESULT_CHARS`, `MAX_SNAPSHOT_MESSAGES`)
   * so that long-running agents cannot blow up the event stream.
   */
  readonly messages: readonly Message[];

  constructor(
    workflowId: string,
    agentId: string,
    turnIndex: number,
    model: string,
    selectedModel: string,
    inputTokens: number,
    outputTokens: number,
    cost: number,
    cumulativeCost: number,
    duration: number,
    toolCallCount: number,
    fallbackAttempts: number,
    reasoningTrace: string | undefined,
    messages: readonly Message[],
  ) {
    super(AgentTurnCompletedEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.turnIndex = turnIndex;
    this.model = model;
    this.selectedModel = selectedModel;
    this.inputTokens = inputTokens;
    this.outputTokens = outputTokens;
    this.cost = cost;
    this.cumulativeCost = cumulativeCost;
    this.duration = duration;
    this.toolCallCount = toolCallCount;
    this.fallbackAttempts = fallbackAttempts;
    this.reasoningTrace = reasoningTrace;
    this.messages = messages;
  }
}
