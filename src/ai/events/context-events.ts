/**
 * Fired when a {@link ContextWindowManager} compacts the conversation to fit
 * within the token limit. Carries the strategy name, token counts before and
 * after, and the number of messages dropped.
 *
 * @example Log compaction stats for observability
 * ```ts
 * import { AgentContextCompactedEvent } from 'weft';
 *
 * const target = new EventTarget();
 *
 * target.addEventListener(AgentContextCompactedEvent.type, (e) => {
 *   const event = e as AgentContextCompactedEvent;
 *   console.log(
 *     `Context compacted via '${event.strategy}': ${event.tokensBefore} → ${event.tokensAfter} tokens`,
 *   );
 * });
 * ```
 */
export class AgentContextCompactedEvent extends Event {
  static readonly type = 'agent:context:compacted' as const;
  readonly workflowId: string;
  readonly agentId: string;
  readonly strategy: string;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly messagesDropped: number;

  constructor(
    workflowId: string,
    agentId: string,
    strategy: string,
    tokensBefore: number,
    tokensAfter: number,
    messagesDropped: number,
  ) {
    super(AgentContextCompactedEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.strategy = strategy;
    this.tokensBefore = tokensBefore;
    this.tokensAfter = tokensAfter;
    this.messagesDropped = messagesDropped;
  }
}
