import {
  validateDefinitionSchemaMetadata,
  type DefinitionSchema,
} from '../core/types/definition-schema.ts';
import type { ToolDefinition } from './agent/types.ts';

/** @internal Brand string for runtime identification of AgentDefinition objects. */
const AGENT_DEFINITION_BRAND = '__weft_agent_definition__' as const;

/**
 * The runtime shape of an agent definition returned by {@link agent}.
 * Register it on an {@link import('../core/engine.ts').Engine} directly or
 * invoke it from inside a workflow via `ctx.agent()`.
 *
 * @example Create and register an agent definition
 * ```ts
 * import { Engine, agent } from 'weft';
 * import type { AgentDefinition, LLMProvider } from 'weft';
 *
 * declare const provider: LLMProvider;
 *
 * const assistant: AgentDefinition = agent({
 *   name: 'summarizer',
 *   model: 'claude-sonnet-4-5',
 *   systemPrompt: 'Summarize the given text concisely.',
 *   maxTurns: 3,
 * });
 *
 * const engine = new Engine();
 * engine.register(assistant, { provider });
 * ```
 */
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
  description?: string;
  /** Optional input schema metadata for introspection; registration validates metadata shape only. */
  inputSchema?: DefinitionSchema<unknown, TInput>;
  /** Optional output schema metadata for introspection; registration validates metadata shape only. */
  outputSchema?: DefinitionSchema<unknown, TOutput>;
  /** @internal Phantom field to carry the input type parameter. */
  readonly _inputType?: TInput;
  /** @internal Phantom field to carry the output type parameter. */
  readonly _outputType?: TOutput;
}

/** Result of a tool identity function - the stable hash and which fields it covered. */
export interface ToolIdentityResult {
  /** 16-character hex hash of the intent-critical fields. */
  semanticHash: string;
  /**
   * Names of the input fields whose values were included in the hash.
   * Informational - identifies which input fields contributed to `semanticHash`.
   */
  intentCriticalFields: string[];
}

/**
 * A flat tool declaration for use inside an {@link AgentDefinition}. It
 * includes the provider-facing descriptor (`name`, optional `description`,
 * and `input`) plus an async `execute` function, optional post-execution
 * `verify` callback, semantic versioning, and optional `identity` function
 * for effect-log deduplication across checkpoint restores.
 *
 * @example
 * ```ts
 * import { computeSemanticHash, type AgentToolDefinition } from 'weft';
 *
 * const sendEmail: AgentToolDefinition = {
 *   name: 'send_email',
 *   description: 'Send a transactional email.',
 *   input: {
 *     type: 'object',
 *     required: ['to', 'subject'],
 *     properties: { to: { type: 'string' }, subject: { type: 'string' } },
 *   },
 *   execute: async (input) => {
 *     const { to, subject } = input as { to: string; subject: string };
 *     return { sent: true, to, subject };
 *   },
 *   identity: (input) => {
 *     const { to, subject } = input as { to: string; subject: string };
 *     return {
 *       semanticHash: computeSemanticHash({ to, subject }),
 *       intentCriticalFields: ['to', 'subject'],
 *     };
 *   },
 * };
 * ```
 */
export type AgentToolDefinition = ToolDefinition;

/**
 * Input options accepted by {@link agent}.
 *
 * @example
 * ```ts
 * import { agent } from 'weft';
 *
 * const assistant = agent({
 *   name: 'assistant',
 *   model: 'claude-sonnet-4-5',
 *   maxTurns: 5,
 * });
 * void assistant;
 * ```
 */
export interface AgentDefinitionOptions<TInput = unknown, TOutput = unknown> {
  name: string;
  model: string;
  /** Semantic version of this agent definition. Defaults to `"0.0.0"` when not provided. */
  version?: string;
  systemPrompt?: string;
  tools?: AgentToolDefinition[];
  maxTurns?: number;
  description?: string;
  /** Optional Standard Schema validator describing the agent's input payload. */
  inputSchema?: DefinitionSchema<unknown, TInput>;
  /** Optional Standard Schema validator describing the agent's output payload. */
  outputSchema?: DefinitionSchema<unknown, TOutput>;
  /** @internal Phantom field to carry the input type parameter. */
  readonly _inputType?: TInput;
  /** @internal Phantom field to carry the output type parameter. */
  readonly _outputType?: TOutput;
}

/**
 * Runtime check: is the value an AgentDefinition created by {@link agent}?
 *
 * @example Guard before calling engine.register with an unknown value
 * ```ts
 * import { isAgentDefinition, agent } from 'weft';
 *
 * const definition = agent({ name: 'my-agent', model: 'claude-sonnet-4-5' });
 * console.log(isAgentDefinition(definition));
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
 * @example Standalone agent registered on an engine
 * ```ts
 * import { Engine, agent, type LLMProvider } from 'weft';
 *
 * declare const provider: LLMProvider;
 *
 * const assistant = agent({
 *   name: 'travel-assistant',
 *   model: 'claude-sonnet-4-5',
 *   systemPrompt: 'You help users book trips.',
 *   maxTurns: 5,
 * });
 *
 * const engine = new Engine();
 * engine.register(assistant, { provider });
 * ```
 */
export function agent<TInput = unknown, TOutput = unknown>(
  options: AgentDefinitionOptions<TInput, TOutput>,
): AgentDefinition<TInput, TOutput> {
  // Validate schema metadata here. Unlike workflow() and activity() — whose
  // schemas pass through engine/activity registration sites that already
  // validate — the agent registration path constructs an internal workflow
  // registration that does not propagate the agent's inputSchema/outputSchema.
  // Without this guard a malformed schema would slip into the registry.
  if (options.inputSchema !== undefined) {
    validateDefinitionSchemaMetadata(options.inputSchema, `agent("${options.name}").inputSchema`);
  }
  if (options.outputSchema !== undefined) {
    validateDefinitionSchemaMetadata(options.outputSchema, `agent("${options.name}").outputSchema`);
  }
  return {
    ...options,
    version: options.version ?? '0.0.0',
    _brand: AGENT_DEFINITION_BRAND,
  };
}
