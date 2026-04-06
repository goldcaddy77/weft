/**
 * Character-based token estimation for context window management.
 *
 * Uses the ~4 characters per token heuristic common for English text,
 * plus a small per-message overhead for role/framing tokens that LLM
 * APIs inject around each message.
 *
 * @module token-counting
 */

import type { Message } from './providers/types.ts';

/** Approximate number of characters per token for English text. */
const CHARACTERS_PER_TOKEN = 4;

/**
 * Overhead tokens added per message to account for role markers,
 * delimiters, and other framing the model API wraps around each turn.
 */
const MESSAGE_OVERHEAD = 3;

/**
 * Estimate the total token count for an array of messages.
 *
 * This is a fast, dependency-free approximation — not a precise
 * tokenizer. It is intentionally conservative (rounds up) so that
 * context window decisions err on the side of compacting early
 * rather than exceeding limits.
 */
export function estimateTokens(messages: Message[]): number {
  let total = 0;

  for (const message of messages) {
    const contentTokens =
      message.content.length > 0 ? Math.ceil(message.content.length / CHARACTERS_PER_TOKEN) : 0;
    total += contentTokens + MESSAGE_OVERHEAD;
  }

  return total;
}
