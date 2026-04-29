import type { Message } from './providers/types.ts';

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
 * Fired after each LLM turn completes, carrying token usage, cost, duration,
 * tool call count, and a snapshot of the conversation. Use this for real-time
 * cost monitoring, audit logging, and per-turn performance dashboards.
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

/**
 * Fired immediately before a tool is executed within an agent turn. Carries the
 * tool name, raw input, source ('local' | 'mcp'), and a per-operation UUID that
 * correlates with the matching {@link AgentToolReturnedEvent}.
 *
 * @example Audit all tool calls with their inputs
 * ```ts
 * import { AgentToolCalledEvent } from 'weft';
 *
 * const target = new EventTarget();
 *
 * target.addEventListener(AgentToolCalledEvent.type, (e) => {
 *   const event = e as AgentToolCalledEvent;
 *   console.log(`Tool called: ${event.toolName} (source: ${event.source})`, event.toolInput);
 * });
 * ```
 */
export class AgentToolCalledEvent extends Event {
  static readonly type = 'agent:tool:called' as const;
  readonly workflowId: string;
  readonly agentId: string;
  readonly turnIndex: number;
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly source: 'local' | 'mcp';
  readonly operationId: string;

  constructor(
    workflowId: string,
    agentId: string,
    turnIndex: number,
    toolName: string,
    toolInput: unknown,
    source: 'local' | 'mcp',
    operationId: string,
  ) {
    super(AgentToolCalledEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.turnIndex = turnIndex;
    this.toolName = toolName;
    this.toolInput = toolInput;
    this.source = source;
    this.operationId = operationId;
  }
}

/**
 * Fired after a tool finishes execution, carrying the tool name, wall-clock
 * duration, success flag, and the operation ID that matches the preceding
 * {@link AgentToolCalledEvent}. Use this to measure tool latency and track failures.
 *
 * @example Monitor tool execution duration and failures
 * ```ts
 * import { AgentToolReturnedEvent } from 'weft';
 *
 * const target = new EventTarget();
 *
 * target.addEventListener(AgentToolReturnedEvent.type, (e) => {
 *   const event = e as AgentToolReturnedEvent;
 *   const status = event.success ? 'ok' : 'error';
 *   console.log(`Tool ${event.toolName} [${status}] ${event.duration}ms`);
 * });
 * ```
 */
export class AgentToolReturnedEvent extends Event {
  static readonly type = 'agent:tool:returned' as const;
  readonly workflowId: string;
  readonly agentId: string;
  readonly turnIndex: number;
  readonly toolName: string;
  readonly duration: number;
  readonly success: boolean;
  readonly operationId: string;

  constructor(
    workflowId: string,
    agentId: string,
    turnIndex: number,
    toolName: string,
    duration: number,
    success: boolean,
    operationId: string,
  ) {
    super(AgentToolReturnedEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.turnIndex = turnIndex;
    this.toolName = toolName;
    this.duration = duration;
    this.success = success;
    this.operationId = operationId;
  }
}

/**
 * Fired when an agent's token or cost usage crosses the configured warning
 * threshold (default 80%). Carries the percentage used, remaining tokens and
 * cost, and the threshold value. Only fires once per agent run.
 *
 * @example Warn users when the agent is close to its budget
 * ```ts
 * import { AgentBudgetWarningEvent } from 'weft';
 *
 * const target = new EventTarget();
 *
 * target.addEventListener(AgentBudgetWarningEvent.type, (e) => {
 *   const event = e as AgentBudgetWarningEvent;
 *   console.warn(
 *     `Budget ${event.budgetUsedPercent.toFixed(0)}% used — ${event.costRemaining.toFixed(4)} remaining`,
 *   );
 * });
 * ```
 */
export class AgentBudgetWarningEvent extends Event {
  static readonly type = 'agent:budget:warning' as const;
  readonly workflowId: string;
  readonly agentId: string;
  readonly budgetUsedPercent: number;
  readonly tokensRemaining: number;
  readonly costRemaining: number;
  readonly threshold: number;

  constructor(
    workflowId: string,
    agentId: string,
    budgetUsedPercent: number,
    tokensRemaining: number,
    costRemaining: number,
    threshold: number,
  ) {
    super(AgentBudgetWarningEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.budgetUsedPercent = budgetUsedPercent;
    this.tokensRemaining = tokensRemaining;
    this.costRemaining = costRemaining;
    this.threshold = threshold;
  }
}

/**
 * Fired when an agent's token or cost usage exceeds the configured maximum,
 * causing the loop to stop. Carries the final usage totals and the configured
 * limits so downstream consumers can report the breach accurately.
 *
 * @example Stop a workflow and surface budget details on breach
 * ```ts
 * import { AgentBudgetExceededEvent } from 'weft';
 *
 * const target = new EventTarget();
 *
 * target.addEventListener(AgentBudgetExceededEvent.type, (e) => {
 *   const event = e as AgentBudgetExceededEvent;
 *   console.error(
 *     `Budget exceeded: ${event.tokensUsed} tokens, ${event.costUsed.toFixed(4)} spent`,
 *   );
 * });
 * ```
 */
export class AgentBudgetExceededEvent extends Event {
  static readonly type = 'agent:budget:exceeded' as const;
  readonly workflowId: string;
  readonly agentId: string;
  readonly tokensUsed: number;
  readonly costUsed: number;
  readonly tokenBudget: number;
  readonly maxCost: number;

  constructor(
    workflowId: string,
    agentId: string,
    tokensUsed: number,
    costUsed: number,
    tokenBudget: number,
    maxCost: number,
  ) {
    super(AgentBudgetExceededEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.tokensUsed = tokensUsed;
    this.costUsed = costUsed;
    this.tokenBudget = tokenBudget;
    this.maxCost = maxCost;
  }
}

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

/**
 * Fired when the agent loop falls back from one model to another after a
 * provider error. Carries the failed model, failure reason, next model to try,
 * and the fallback attempt index for multi-step fallback chains.
 *
 * @example Alert when model fallbacks occur
 * ```ts
 * import { AgentModelFallbackEvent } from 'weft';
 *
 * const target = new EventTarget();
 *
 * target.addEventListener(AgentModelFallbackEvent.type, (e) => {
 *   const event = e as AgentModelFallbackEvent;
 *   console.warn(`Model fallback: ${event.failedModel} → ${event.nextModel} — ${event.failedReason}`);
 * });
 * ```
 */
export class AgentModelFallbackEvent extends Event {
  static readonly type = 'agent:model:fallback' as const;
  readonly workflowId: string;
  readonly agentId: string;
  readonly turnIndex: number;
  readonly failedModel: string;
  readonly failedReason: string;
  readonly nextModel: string;
  readonly attemptIndex: number;

  constructor(
    workflowId: string,
    agentId: string,
    turnIndex: number,
    failedModel: string,
    failedReason: string,
    nextModel: string,
    attemptIndex: number,
  ) {
    super(AgentModelFallbackEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.turnIndex = turnIndex;
    this.failedModel = failedModel;
    this.failedReason = failedReason;
    this.nextModel = nextModel;
    this.attemptIndex = attemptIndex;
  }
}

/**
 * Fired by {@link ProviderHealthTracker} when a provider's circuit breaker
 * trips to the open state after the error rate exceeds the configured threshold.
 * Carries the provider name, current error rate, threshold, and window duration.
 *
 * @example Alert when a provider circuit opens
 * ```ts
 * import { AgentProviderCircuitOpenEvent } from 'weft';
 *
 * const target = new EventTarget();
 *
 * target.addEventListener(AgentProviderCircuitOpenEvent.type, (e) => {
 *   const event = e as AgentProviderCircuitOpenEvent;
 *   console.error(
 *     `Circuit open for '${event.provider}': error rate ${(event.errorRate * 100).toFixed(0)}%`,
 *   );
 * });
 * ```
 */
export class AgentProviderCircuitOpenEvent extends Event {
  static readonly type = 'agent:provider:circuit-open' as const;
  readonly provider: string;
  readonly errorRate: number;
  readonly threshold: number;
  readonly windowDuration: number;

  constructor(provider: string, errorRate: number, threshold: number, windowDuration: number) {
    super(AgentProviderCircuitOpenEvent.type);
    this.provider = provider;
    this.errorRate = errorRate;
    this.threshold = threshold;
    this.windowDuration = windowDuration;
  }
}

/**
 * Fired by {@link ReviewCoordinator} when a new human review request is
 * persisted. Carries the `workflowId`, `reviewId`, `reviewType`, and the list
 * of requested `reviewers`. Subscribe to this event to notify reviewers via
 * email, webhook, or ticketing system.
 *
 * @example Route review notifications to a webhook
 * ```ts
 * import { HumanReviewRequestedEvent } from 'weft';
 *
 * const target = new EventTarget();
 *
 * target.addEventListener(HumanReviewRequestedEvent.type, (e) => {
 *   const event = e as HumanReviewRequestedEvent;
 *   console.log(`Review ${event.reviewId} requested for workflow ${event.workflowId}`);
 *   console.log('Reviewers:', event.reviewers);
 * });
 * ```
 */
export class HumanReviewRequestedEvent extends Event {
  static readonly type = 'human-review:requested' as const;
  readonly workflowId: string;
  readonly reviewId: string;
  readonly reviewType: string;
  readonly reviewers: string[];

  constructor(workflowId: string, reviewId: string, reviewType: string, reviewers: string[]) {
    super(HumanReviewRequestedEvent.type);
    this.workflowId = workflowId;
    this.reviewId = reviewId;
    this.reviewType = reviewType;
    this.reviewers = reviewers;
  }
}

/**
 * Fired by {@link ReviewCoordinator} when a reviewer submits a decision.
 * Carries the `reviewId`, `decision` string, `reviewer` identifier, and the
 * time elapsed since the review was created. Use this to close tickets, record
 * audit logs, or trigger downstream workflow steps.
 *
 * @example Record review decisions in an audit log
 * ```ts
 * import { HumanReviewCompletedEvent } from 'weft';
 *
 * const target = new EventTarget();
 *
 * target.addEventListener(HumanReviewCompletedEvent.type, (e) => {
 *   const event = e as HumanReviewCompletedEvent;
 *   console.log(`Review ${event.reviewId}: '${event.decision}' by ${event.reviewer} in ${event.duration}ms`);
 * });
 * ```
 */
export class HumanReviewCompletedEvent extends Event {
  static readonly type = 'human-review:completed' as const;
  readonly workflowId: string;
  readonly reviewId: string;
  readonly decision: string;
  readonly reviewer: string;
  readonly duration: number;

  constructor(
    workflowId: string,
    reviewId: string,
    decision: string,
    reviewer: string,
    duration: number,
  ) {
    super(HumanReviewCompletedEvent.type);
    this.workflowId = workflowId;
    this.reviewId = reviewId;
    this.decision = decision;
    this.reviewer = reviewer;
    this.duration = duration;
  }
}

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

export type WeftAgentEventMap = {
  'agent:turn:started': AgentTurnStartedEvent;
  'agent:turn:completed': AgentTurnCompletedEvent;
  'agent:tool:called': AgentToolCalledEvent;
  'agent:tool:returned': AgentToolReturnedEvent;
  'agent:budget:warning': AgentBudgetWarningEvent;
  'agent:budget:exceeded': AgentBudgetExceededEvent;
  'agent:context:compacted': AgentContextCompactedEvent;
  'agent:checkpoint-size-warning': AgentCheckpointSizeWarningEvent;
  'agent:model:fallback': AgentModelFallbackEvent;
  'agent:provider:circuit-open': AgentProviderCircuitOpenEvent;
  'human-review:requested': HumanReviewRequestedEvent;
  'human-review:completed': HumanReviewCompletedEvent;
  'agent:checkpoint:resumed': AgentCheckpointResumedEvent;
};
