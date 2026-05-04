import type { Message } from '../providers/types.ts';

/**
 * Anthropic provider metadata that marks a cache boundary.
 *
 * Carried on the last message in a stable prefix via {@link AnnotatedMessage}.
 * The Anthropic provider adapter reads this field and attaches
 * `cache_control: { type: 'ephemeral' }` to the corresponding API request.
 *
 * @example Inspect a cache boundary marker on an annotated message
 * ```ts
 * import type { AnthropicCacheControl, AnnotatedMessage } from 'weft';
 *
 * const msg: AnnotatedMessage = {
 *   role: 'system',
 *   content: 'You are helpful.',
 *   providerMetadata: { anthropic: { cacheControl: { type: 'ephemeral' } } },
 * };
 *
 * const cc: AnthropicCacheControl | undefined = msg.providerMetadata?.anthropic;
 * console.log(cc?.cacheControl.type); // 'ephemeral'
 * ```
 */
export interface AnthropicCacheControl {
  cacheControl: { type: 'ephemeral' };
}

/**
 * Provider metadata envelope carried on annotated messages.
 *
 * Extensible: additional provider namespaces (e.g., `openai`) may be added
 * in the future without breaking existing consumers.
 *
 * @example Construct metadata manually for testing
 * ```ts
 * import type { PromptCacheProviderMetadata } from 'weft';
 *
 * const meta: PromptCacheProviderMetadata = {
 *   anthropic: { cacheControl: { type: 'ephemeral' } },
 * };
 * ```
 */
export interface PromptCacheProviderMetadata {
  anthropic?: AnthropicCacheControl;
}

/**
 * A `Message` with an optional `providerMetadata` field added by
 * {@link PromptCache.annotate}. The extra field is transparent to callers
 * that do not inspect it, and is read by Anthropic-aware provider adapters
 * to attach `cache_control` to the corresponding API request content block.
 *
 * @example Pass annotated messages to an LLM provider
 * ```ts
 * import { PromptCache, type AnnotatedMessage } from 'weft';
 *
 * const cache = new PromptCache();
 * const { messages } = cache.annotate([
 *   { role: 'system', content: 'You are helpful.' },
 *   { role: 'user',   content: 'Hello!' },
 * ]);
 *
 * // Cast is safe: AnnotatedMessage is structurally identical to Message.
 * const annotated: AnnotatedMessage[] = messages;
 * console.log(annotated[0]?.providerMetadata?.anthropic?.cacheControl.type);
 * ```
 */
export type AnnotatedMessage = Message & {
  providerMetadata?: PromptCacheProviderMetadata;
};

/** Returned by {@link PromptCache.annotate}. */
export interface AnnotateResult {
  /**
   * On a hit, a shallow-copied array with the boundary message replaced by an
   * annotated copy. On a miss, the original input array is returned unchanged
   * (no allocation).
   */
  messages: AnnotatedMessage[];
  /** True when a prefix of ≥2 messages was found in the trie. */
  hit: boolean;
}

// ---------------------------------------------------------------------------
// Metric names
// ---------------------------------------------------------------------------

/**
 * Counter name for prompt cache hits.
 *
 * @example Increment the counter in a custom metrics collector
 * ```ts
 * import { PROMPT_CACHE_HIT_METRIC, PROMPT_CACHE_MISS_METRIC } from 'weft';
 *
 * const counts: Record<string, number> = {};
 * const collector = {
 *   increment(name: string) { counts[name] = (counts[name] ?? 0) + 1; },
 * };
 *
 * // collector is passed to PromptCache constructor as the metrics option.
 * console.log(PROMPT_CACHE_HIT_METRIC);  // 'weft.prompt_cache.hits'
 * console.log(PROMPT_CACHE_MISS_METRIC); // 'weft.prompt_cache.misses'
 * ```
 */
export const PROMPT_CACHE_HIT_METRIC = 'weft.prompt_cache.hits';
/**
 * Counter name for prompt cache misses.
 *
 * @example Read miss totals directly from the PromptCache instance
 * ```ts
 * import { PROMPT_CACHE_MISS_METRIC, PromptCache } from 'weft';
 *
 * // The metric name is used by a MetricsCollector passed to the constructor.
 * console.log(PROMPT_CACHE_MISS_METRIC); // 'weft.prompt_cache.misses'
 *
 * const cache = new PromptCache();
 * cache.annotate([{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'Hi' }]);
 *
 * // Access totals directly without a MetricsCollector.
 * console.log('Misses so far:', cache.misses);
 * ```
 */
export const PROMPT_CACHE_MISS_METRIC = 'weft.prompt_cache.misses';

// ---------------------------------------------------------------------------
// Radix trie internals
// ---------------------------------------------------------------------------
