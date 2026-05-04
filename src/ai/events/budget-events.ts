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
