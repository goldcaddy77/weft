import type { BudgetOptions } from './budget.ts';
import type { ContextStrategy } from './context-window.ts';
import type { AgentHooks } from './hooks.ts';
import type { ModelRouter } from './model-router.ts';
import type { ToolDefinition } from './providers/types.ts';

export interface AgentDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  model: string;
  systemPrompt?: string;
  tools?: AgentToolDefinition[];
  maxTurns?: number;
  budget?: BudgetOptions;
  modelRouter?: ModelRouter;
  contextStrategy?: ContextStrategy;
  hooks?: AgentHooks;
  description?: string;
  /** @internal Phantom field to carry the input type parameter. */
  readonly _inputType?: TInput;
  /** @internal Phantom field to carry the output type parameter. */
  readonly _outputType?: TOutput;
}

export interface AgentToolDefinition {
  definition: ToolDefinition;
  execute: (input: unknown) => Promise<unknown>;
}

export interface AgentDefinitionOptions<TInput = unknown, TOutput = unknown> {
  name: string;
  model: string;
  systemPrompt?: string;
  tools?: AgentToolDefinition[];
  maxTurns?: number;
  budget?: BudgetOptions;
  modelRouter?: ModelRouter;
  contextStrategy?: ContextStrategy;
  hooks?: AgentHooks;
  description?: string;
  /** @internal Phantom field to carry the input type parameter. */
  readonly _inputType?: TInput;
  /** @internal Phantom field to carry the output type parameter. */
  readonly _outputType?: TOutput;
}

/** Declare a reusable agent definition. */
export function defineAgent<TInput = unknown, TOutput = unknown>(
  options: AgentDefinitionOptions<TInput, TOutput>,
): AgentDefinition<TInput, TOutput> {
  return { ...options };
}
