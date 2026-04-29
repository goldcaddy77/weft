import type { TenantContext } from '../core/tenant.ts';
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
  /** Semantic version of this agent definition. Defaults to `"0.0.0"` when not provided. */
  version?: string;
  systemPrompt?: string;
  tools?: AgentToolDefinition[];
  maxTurns?: number;
  budget?: BudgetOptions;
  modelRouter?: ModelRouter;
  contextStrategy?: ContextStrategy;
  hooks?: AgentHooks;
  description?: string;
  /**
   * Return the tool set this agent should expose for the given tenant. When
   * present, the engine calls this on each `ctx.agent()` invocation and uses
   * the returned list instead of `tools`. Use this to hide tools from
   * tenants that lack permission, or to inject tenant-scoped credentials.
   */
  toolsForTenant?: (tenant: TenantContext | undefined) => AgentToolDefinition[];
  /**
   * Validate workflow input for a given tenant before the agent runs. Throw
   * any error to fail the workflow. Use this to enforce per-tenant payload
   * schemas without adding custom logic inside the agent handler.
   *
   * The stored signature accepts `unknown` instead of the declaration-time
   * `TInput` so that `AgentDefinition<{...}>` remains assignable *into* the
   * erased `AgentDefinition<unknown, unknown>` form used by
   * `engine.register()`. Call sites that want to author the validator with
   * the typed shape should use the {@link AgentDefinitionOptions} form,
   * where `TInput` is preserved and `defineAgent()` bridges the variance.
   */
  validateInput?: (input: unknown, tenant: TenantContext | undefined) => void;
  /** @internal Phantom field to carry the input type parameter. */
  readonly _inputType?: TInput;
  /** @internal Phantom field to carry the output type parameter. */
  readonly _outputType?: TOutput;
}

/** Result of a tool identity function — the stable hash and which fields it covered. */
export interface ToolIdentityResult {
  /** 16-character hex hash of the intent-critical fields. */
  semanticHash: string;
  /**
   * Names of the input fields whose values were included in the hash.
   * Informational — identifies which input fields contributed to `semanticHash`.
   */
  intentCriticalFields: string[];
}

export interface AgentToolDefinition {
  definition: ToolDefinition;
  execute: (input: unknown) => Promise<unknown>;
  /**
   * Optional post-execution verifier for the raw tool result.
   *
   * Return `true` to accept the tool output, or `false` to reject it.
   * Throwing is treated the same as a failed verification.
   */
  verify?: (result: unknown) => Promise<boolean> | boolean;
  /** Semantic version of this tool. Used for workflow resume compatibility checks. Defaults to `"0.0.0"` when not provided. */
  version?: string;
  /**
   * Compute a stable semantic identity for a tool invocation.
   *
   * When provided, the engine uses the returned `semanticHash` as the key in
   * the tool effect log. This lets you exclude non-critical fields (retry
   * counters, timestamps, nonces) from the hash while still deduplicating on
   * the fields that determine the tool's observable effect (recipient, amount,
   * resource ID).
   *
   * When absent, the engine hashes the full input with {@link computeSemanticHash}.
   *
   * @example Mark only the payment-critical fields
   * ```ts
   * import { computeSemanticHash } from 'weft';
   *
   * const chargeTool: AgentToolDefinition = {
   *   definition: { name: 'charge', ... },
   *   execute: async (input) => { ... },
   *   identity: (input) => {
   *     const { recipient, amount } = input as { recipient: string; amount: number };
   *     return {
   *       semanticHash: computeSemanticHash({ recipient, amount }),
   *       intentCriticalFields: ['recipient', 'amount'],
   *     };
   *   },
   * };
   * ```
   */
  identity?: (input: unknown) => ToolIdentityResult;
}

export interface AgentDefinitionOptions<TInput = unknown, TOutput = unknown> {
  name: string;
  model: string;
  /** Semantic version of this agent definition. Defaults to `"0.0.0"` when not provided. */
  version?: string;
  systemPrompt?: string;
  tools?: AgentToolDefinition[];
  maxTurns?: number;
  budget?: BudgetOptions;
  modelRouter?: ModelRouter;
  contextStrategy?: ContextStrategy;
  hooks?: AgentHooks;
  description?: string;
  /** See {@link AgentDefinition.toolsForTenant}. */
  toolsForTenant?: (tenant: TenantContext | undefined) => AgentToolDefinition[];
  /** See {@link AgentDefinition.validateInput}. */
  validateInput?: (input: TInput, tenant: TenantContext | undefined) => void;
  /** @internal Phantom field to carry the input type parameter. */
  readonly _inputType?: TInput;
  /** @internal Phantom field to carry the output type parameter. */
  readonly _outputType?: TOutput;
}

/**
 * Runtime check: is the value an AgentDefinition created by {@link defineAgent}?
 *
 * @example Guard before calling engine.register with an unknown value
 * ```ts
 * import { isAgentDefinition, defineAgent } from 'weft';
 *
 * const definition = defineAgent({ name: 'my-agent', model: 'claude-sonnet-4-5' });
 *
 * function registerIfAgent(value: unknown): void {
 *   if (isAgentDefinition(value)) {
 *     console.log('Registering agent:', value.name);
 *   } else {
 *     console.log('Not an agent definition');
 *   }
 * }
 *
 * registerIfAgent(definition);  // logs: Registering agent: my-agent
 * registerIfAgent({ name: 'x' }); // logs: Not an agent definition
 * ```
 */
export function isAgentDefinition(value: unknown): value is AgentDefinition {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj['_brand'] === AGENT_DEFINITION_BRAND &&
    typeof obj['name'] === 'string' &&
    typeof obj['model'] === 'string'
  );
}

/**
 * Declare a reusable agent definition.
 *
 * An agent is a workflow that drives an LLM in a tool-calling loop: pick a
 * model, provide a system prompt, list the tools the model may call, and
 * optionally cap cost and turns. `defineAgent` returns a definition object
 * that can be registered directly on an {@link Engine} (where it becomes a
 * top-level workflow) or invoked from inside another workflow via
 * `ctx.agent()`.
 *
 * @example Standalone agent registered on an engine
 * ```ts
 * import { Engine, defineAgent, type LLMProvider } from 'weft';
 *
 * declare const myProvider: LLMProvider;
 *
 * const assistant = defineAgent({
 *   name: 'travel-assistant',
 *   model: 'claude-sonnet-4-5',
 *   systemPrompt: 'You help users book trips.',
 *   maxTurns: 5,
 *   budget: {
 *     maxCost: 1.0,
 *     models: { 'claude-sonnet-4-5': { inputCostPer1K: 0.003, outputCostPer1K: 0.015 } },
 *   },
 * });
 *
 * const engine = new Engine();
 * engine.register(assistant, { provider: myProvider });
 *
 * const handle = await engine.start('travel-assistant', 'Book me a flight to Tokyo');
 * const answer = await handle.result();
 * ```
 *
 * @example Per-tenant tool customization
 * ```ts
 * import { defineAgent, type AgentToolDefinition } from 'weft';
 *
 * const searchTool: AgentToolDefinition = {
 *   definition: { name: 'search', description: 'search', inputSchema: { type: 'object' } },
 *   execute: async () => [],
 * };
 * const adminTool: AgentToolDefinition = {
 *   definition: { name: 'refund', description: 'refund', inputSchema: { type: 'object' } },
 *   execute: async () => null,
 * };
 *
 * const agent = defineAgent({
 *   name: 'support-agent',
 *   model: 'claude-sonnet-4-5',
 *   toolsForTenant(tenant) {
 *     if (tenant?.attributes?.['role'] === 'admin') return [searchTool, adminTool];
 *     return [searchTool];
 *   },
 *   validateInput(input, tenant) {
 *     if (!tenant) throw new Error('tenant required');
 *   },
 * });
 * ```
 */
export function defineAgent<TInput = unknown, TOutput = unknown>(
  options: AgentDefinitionOptions<TInput, TOutput>,
): AgentDefinition<TInput, TOutput> {
  const { validateInput, ...rest } = options;
  const definition: AgentDefinition<TInput, TOutput> = {
    ...rest,
    version: rest.version ?? '0.0.0',
    _brand: AGENT_DEFINITION_BRAND,
  };
  // Widen the caller's typed validator to the stored `unknown` signature so
  // the resulting AgentDefinition stays assignable to the erased form used
  // by `engine.register()`. Runtime behavior is unchanged.
  if (validateInput !== undefined) {
    definition.validateInput = validateInput as (
      input: unknown,
      tenant: TenantContext | undefined,
    ) => void;
  }
  return definition;
}
