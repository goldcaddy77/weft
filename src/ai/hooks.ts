import type { Message, ToolCall } from './providers/types.ts';

/**
 * Optional lifecycle callbacks that plug into the agent loop. `beforeTurn` can
 * inspect or modify the message list, or skip a turn entirely and return a
 * static result. `afterToolCall` can transform or reject a tool result before
 * it reaches the model. `onBudgetWarning` fires once when usage crosses the
 * configured threshold.
 *
 * @example Inject a freshness check before each turn
 * ```ts
 * import type { AgentHooks } from 'weft';
 *
 * const hooks: AgentHooks = {
 *   beforeTurn: async ({ turnIndex, messages, model }) => {
 *     if (turnIndex > 0 && messages.length > 50) {
 *       // Skip the turn and return a canned message to stop runaway loops.
 *       return { action: 'skip', result: 'Conversation too long — stopping.' };
 *     }
 *     return { action: 'continue' };
 *   },
 *   onBudgetWarning: ({ budgetUsedPercent }) => {
 *     console.warn(`Budget ${budgetUsedPercent.toFixed(0)}% used`);
 *   },
 * };
 * ```
 */
export interface AgentHooks {
  /** Runs before each LLM call. Can modify messages or skip the turn. */
  beforeTurn?: (context: BeforeTurnContext) => BeforeTurnResult | Promise<BeforeTurnResult>;
  /** Runs after each tool call. Can modify the result. */
  afterToolCall?: (
    context: AfterToolCallContext,
  ) => AfterToolCallResult | Promise<AfterToolCallResult>;
  /** Runs when budget warning threshold is crossed. */
  onBudgetWarning?: (context: BudgetWarningContext) => void | Promise<void>;
}

export interface BeforeTurnContext {
  turnIndex: number;
  messages: Message[];
  model: string;
}

export type BeforeTurnResult =
  | { action: 'continue'; messages?: Message[] }
  | { action: 'skip'; result?: string };

export interface AfterToolCallContext {
  turnIndex: number;
  toolCall: ToolCall;
  result: unknown;
}

export type AfterToolCallResult =
  | { action: 'continue'; result?: unknown }
  | { action: 'reject'; reason: string };

export interface BudgetWarningContext {
  tokensRemaining: number;
  costRemaining: number;
  budgetUsedPercent: number;
}
