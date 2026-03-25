import type { Message } from './providers/types.ts';

/** Strategy for compacting conversation history. Returns a generator for durable operations. */
export interface ContextStrategy {
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

type ResolvedContextWindowOptions = Required<ContextWindowOptions>;

export class ContextWindowManager {
  #options: ResolvedContextWindowOptions;

  constructor(options: ContextWindowOptions) {
    const maxTokens = options.maxTokens;
    const reservedForOutput = options.reservedForOutput ?? Math.floor(maxTokens * 0.25);

    this.#options = {
      maxTokens,
      reservedForOutput,
      compactAt: options.compactAt ?? 0.85,
      strategy: options.strategy ?? noopStrategy(),
      countTokens: options.countTokens ?? defaultCountTokens,
    };
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
}

/** Compose multiple strategies: apply in sequence, checkpoint between each. */
export function composeStrategies(...strategies: ContextStrategy[]): ContextStrategy {
  return {
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

/** No-op pass-through strategy (default). */
export function noopStrategy(): ContextStrategy {
  return {
    async *compact(messages: Message[]): AsyncGenerator<Message[], Message[], unknown> {
      yield messages;
      return messages;
    },
  };
}

async function defaultCountTokens(messages: Message[]): Promise<number> {
  return messages.reduce((sum, message) => sum + Math.ceil(message.content.length / 4), 0);
}
