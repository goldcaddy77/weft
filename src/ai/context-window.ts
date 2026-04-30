import type { Message } from './providers/types.ts';

import { estimateTokens } from './token-counting.ts';

/**
 * Strategy for compacting conversation history. Returns a generator for durable operations.
 *
 * @example Implement a truncation strategy that keeps only the last N messages
 * ```ts
 * import type { ContextStrategy } from 'weft';
 * import { ContextWindowManager } from 'weft';
 *
 * const keepLastN = (n: number): ContextStrategy => ({
 *   name: `keep-last-${n}`,
 *   async *compact(messages) {
 *     const kept = messages.slice(-n);
 *     yield kept;
 *     return kept;
 *   },
 * });
 *
 * const manager = new ContextWindowManager({
 *   maxTokens: 8192,
 *   strategy: keepLastN(20),
 * });
 * ```
 */
export interface ContextStrategy {
  /** Human-readable label identifying this strategy (e.g. 'sliding-window', 'summarize'). */
  name: string;
  compact(
    messages: Message[],
    options: CompactOptions,
  ): AsyncGenerator<Message[], Message[], unknown>;
}

export interface CompactOptions {
  maxTokens: number;
  reservedForOutput: number;
  currentTokenCount: number;
}

export interface ContextWindowOptions {
  maxTokens: number;
  reservedForOutput?: number;
  compactAt?: number;
  strategy?: ContextStrategy;
  countTokens?: (messages: Message[]) => Promise<number>;
}

/** Serializable snapshot of the context window state for crash recovery. */
export interface ContextWindowCheckpoint {
  compactedMessages: Message[] | null;
}

type ResolvedContextWindowOptions = Required<ContextWindowOptions>;

/**
 * Manages context window compaction for long-running agent conversations.
 * Monitors token count against a configured limit, invokes the active
 * {@link ContextStrategy} when the window fills, and checkpoints compacted
 * state via {@link ContextWindowManager.checkpoint} for crash recovery.
 *
 * @example Use a sliding-window strategy and check compaction threshold
 * ```ts
 * import { ContextWindowManager, slidingWindowStrategy } from 'weft';
 *
 * const manager = new ContextWindowManager({
 *   maxTokens: 100_000,
 *   reservedForOutput: 8_192,
 *   compactAt: 0.85,
 *   strategy: slidingWindowStrategy({ preserveRecentCount: 30 }),
 * });
 *
 * // Check whether the current token count warrants compaction
 * const needsCompaction = manager.shouldCompact(90_000);
 * console.log('Input budget:', manager.inputBudget);
 * console.log('Needs compaction:', needsCompaction);
 * ```
 */
export class ContextWindowManager {
  #options: ResolvedContextWindowOptions;
  #compactedMessages: Message[] | null = null;

  constructor(options: ContextWindowOptions) {
    const maxTokens = options.maxTokens;
    const reservedForOutput = options.reservedForOutput ?? Math.floor(maxTokens * 0.25);

    this.#options = {
      maxTokens,
      reservedForOutput,
      compactAt: options.compactAt ?? 0.85,
      strategy: options.strategy ?? noopStrategy(),
      countTokens:
        options.countTokens ?? ((messages: Message[]) => Promise.resolve(estimateTokens(messages))),
    };
  }

  /** The name of the active compaction strategy. */
  get strategyName(): string {
    return this.#options.strategy.name;
  }

  /** Check if compaction is needed based on token count. */
  shouldCompact(tokenCount: number): boolean {
    return tokenCount >= this.inputBudget * this.#options.compactAt;
  }

  /** Apply the context strategy to compact messages. */
  async compact(messages: Message[]): Promise<{
    messages: Message[];
    tokensBefore: number;
    tokensAfter: number;
    messagesDropped: number;
  }> {
    const tokensBefore = await this.#options.countTokens(messages);
    const messageCountBefore = messages.length;

    const generator = this.#options.strategy.compact(messages, {
      maxTokens: this.#options.maxTokens,
      reservedForOutput: this.#options.reservedForOutput,
      currentTokenCount: tokensBefore,
    });

    const result = await generator.next();
    const compactedMessages = result.value ?? messages;
    const tokensAfter = await this.#options.countTokens(compactedMessages);

    this.#compactedMessages = compactedMessages;

    return {
      messages: compactedMessages,
      tokensBefore,
      tokensAfter,
      messagesDropped: messageCountBefore - compactedMessages.length,
    };
  }

  /** Get the available input token budget. */
  get inputBudget(): number {
    return this.#options.maxTokens - this.#options.reservedForOutput;
  }

  /** Create a serializable snapshot of the current compacted state. */
  checkpoint(): ContextWindowCheckpoint {
    return {
      compactedMessages: this.#compactedMessages ? [...this.#compactedMessages] : null,
    };
  }

  /** Restore compacted state from a checkpoint, avoiding re-running the strategy. */
  restore(checkpoint: ContextWindowCheckpoint): void {
    this.#compactedMessages = checkpoint.compactedMessages
      ? [...checkpoint.compactedMessages]
      : null;
  }

  /** Return the stored compacted messages, or null if none exist. */
  getCompactedMessages(): Message[] | null {
    return this.#compactedMessages;
  }

  /** Clear the stored compacted messages (e.g., after the agent consumes them). */
  clearCompactedMessages(): void {
    this.#compactedMessages = null;
  }
}

/**
 * Compose multiple strategies: apply in sequence, checkpoint between each.
 *
 * @example Chain a sliding-window pass followed by a custom summariser
 * ```ts
 * import { composeStrategies, noopStrategy, ContextWindowManager } from 'weft';
 *
 * // Compose two strategies: run the first, then the second on the result.
 * const combined = composeStrategies(noopStrategy(), noopStrategy());
 *
 * const manager = new ContextWindowManager({
 *   maxTokens: 16_384,
 *   strategy: combined,
 * });
 * ```
 */
export function composeStrategies(...strategies: ContextStrategy[]): ContextStrategy {
  return {
    name: `compose(${strategies.map((s) => s.name).join(', ')})`,
    async *compact(
      messages: Message[],
      options: CompactOptions,
    ): AsyncGenerator<Message[], Message[], unknown> {
      let current = messages;

      for (const strategy of strategies) {
        const generator = strategy.compact(current, {
          ...options,
          currentTokenCount: options.currentTokenCount,
        });
        const result = await generator.next();
        current = result.value ?? current;
      }

      yield current;
      return current;
    },
  };
}

/**
 * No-op pass-through strategy (default).
 *
 * Returns the original message array unchanged. Used as the default
 * {@link ContextWindowManager} strategy when none is specified.
 *
 * @example Explicitly opt in to the no-op default
 * ```ts
 * import { noopStrategy, ContextWindowManager } from 'weft';
 *
 * const manager = new ContextWindowManager({
 *   maxTokens: 4096,
 *   strategy: noopStrategy(),
 * });
 *
 * // manager.shouldCompact(tokenCount) will still fire, but compact() is a no-op.
 * ```
 */
export function noopStrategy(): ContextStrategy {
  return {
    name: 'noop',
    async *compact(messages: Message[]): AsyncGenerator<Message[], Message[], unknown> {
      yield messages;
      return messages;
    },
  };
}
