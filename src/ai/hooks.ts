import type { Message, ToolCall } from './providers/types.ts';

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
