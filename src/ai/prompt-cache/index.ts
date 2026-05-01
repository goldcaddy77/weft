/**
 * Prompt prefix cache using a radix (prefix) trie.
 *
 * LLM providers (Anthropic, OpenAI) support prompt caching: when the request
 * shares a prefix with a recent request, the provider reuses its internal
 * KV-cached activations, cutting both latency and cost by 45–60% on repeated
 * patterns.
 *
 * This module identifies the *stable prefix* of a message array — the system
 * prompt, tool definitions, and any fixed early messages — and annotates the
 * last message of that prefix with an Anthropic `cache_control: ephemeral`
 * marker so the provider knows to cache up to that point.
 *
 * The trie is keyed by per-message hash values (64-bit, via `hashString`),
 * represented as 16-hex-char strings. Two arrays share a prefix when their
 * first N messages hash identically. A hit requires at least two matching
 * messages (a single-message prefix is too short to be worth caching).
 *
 * @see arXiv 2603.16104 ("Helium") for the research motivation.
 *
 * @module ai/prompt-cache
 */

export * from './cache.ts';
export * from './types.ts';
