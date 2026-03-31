import type { BudgetOptions } from './budget.ts';
import type { ContextStrategy } from './context-window.ts';
import type { AgentHooks } from './hooks.ts';
import type { ModelRouter } from './model-router.ts';
import type { ToolDefinition } from './providers/types.ts';

/** @internal Brand string for runtime identification of AgentDefinition objects. */
const AGENT_DEFINITION_BRAND = '__weft_agent_definition__' as const;

export interface AgentDefinition<TInput = unknown, TOutput = unknown> {
  /** @internal Runtime brand for identification via isAgentDefinition(). */
  readonly _brand: string;
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

/** Runtime check: is the value an AgentDefinition created by defineAgent()? */
export function isAgentDefinition(value: unknown): value is AgentDefinition {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  // Accept branded definitions from defineAgent()
  if (obj['_brand'] === AGENT_DEFINITION_BRAND) return true;
  // Also accept duck-typed definitions with required fields (name + model)
  return typeof obj['name'] === 'string' && typeof obj['model'] === 'string';
}

/** Declare a reusable agent definition. */
export function defineAgent<TInput = unknown, TOutput = unknown>(
  options: AgentDefinitionOptions<TInput, TOutput>,
): AgentDefinition<TInput, TOutput> {
  return { ...options, _brand: AGENT_DEFINITION_BRAND };
}
