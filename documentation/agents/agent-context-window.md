# Context Window Management

Your agent is on turn 47. The conversation history has grown to 90,000 tokens. The model's context window is 128K, but you need to reserve space for the output and the tool definitions. If you send the full history, the API rejects it. If you truncate naively, the agent loses critical context from early turns. You need a strategy—and the strategy needs to survive checkpoints.

`ContextWindowManager` and the `ContextStrategy` interface give you exactly this.

## ContextWindowManager

The manager monitors token counts and applies a compaction strategy when the conversation approaches the limit.

```typescript
import { ContextWindowManager } from 'weft';

const contextManager = new ContextWindowManager({
  maxTokens: 128_000,
  reservedForOutput: 32_000,
  compactAt: 0.85,
});
```

The options:

| Field               | Type                                       | Default                  | Description                                       |
| ------------------- | ------------------------------------------ | ------------------------ | ------------------------------------------------- |
| `maxTokens`         | `number`                                   | _required_               | The model's total context window size             |
| `reservedForOutput` | `number`                                   | 25% of `maxTokens`       | Tokens reserved for the model's response          |
| `compactAt`         | `number`                                   | `0.85`                   | Fraction of input budget that triggers compaction |
| `strategy`          | `ContextStrategy`                          | `noopStrategy()`         | The compaction strategy to apply                  |
| `countTokens`       | `(messages: Message[]) => Promise<number>` | character-based estimate | Custom token counting function                    |

The **input budget** is `maxTokens - reservedForOutput`. So with 128K total and 32K reserved, you have 96K for input. Compaction triggers when the conversation reaches 85% of that—about 81,600 tokens.

Check whether compaction is needed:

```typescript
const tokenCount = await provider.countTokens(conversation);
if (contextManager.shouldCompact(tokenCount)) {
  const result = await contextManager.compact(conversation);
  // result.messages — the compacted conversation
  // result.tokensBefore — token count before compaction
  // result.tokensAfter — token count after
  // result.messagesDropped — how many messages were removed
}
```

The `compact()` method returns the compacted messages along with metrics about what changed. The agent loop uses these metrics to emit `AgentContextCompactedEvent` (see [observability](./agent-observability.md)).

You can check the input budget directly:

```typescript
console.log(contextManager.inputBudget); // 96000
```

## The ContextStrategy interface

A strategy is an object with a single method: `compact()`. It receives the current messages and options, and returns a generator that yields the compacted messages.

```typescript
interface ContextStrategy {
  name: string;
  compact(
    messages: Message[],
    options: CompactOptions,
  ): AsyncGenerator<Message[], Message[], unknown>;
}
```

The `name` field is a human-readable label (e.g. `'sliding-window'`) that surfaces in `AgentContextCompactedEvent.strategy`, making it easy to tell from observability which strategy triggered a given compaction.

The generator pattern exists for durability—the engine can checkpoint between strategy steps. For most strategies, you'll yield once and return.

The `CompactOptions` provide context about the current state:

```typescript
interface CompactOptions {
  maxTokens: number;
  reservedForOutput: number;
  currentTokenCount: number;
}
```

## Built-in: sliding window strategy

The most common approach is to keep the system message and the N most recent messages, dropping everything in between.

```typescript
import { slidingWindowStrategy } from 'weft';

const strategy = slidingWindowStrategy({
  preserveSystemMessage: true, // Keep the system prompt (default: true)
  preserveRecentCount: 10, // Keep the last 10 non-system messages (default: 10)
});
```

Wire it into the manager:

```typescript
const contextManager = new ContextWindowManager({
  maxTokens: 128_000,
  strategy,
});
```

When compaction triggers, the strategy preserves the system message (if present and if `preserveSystemMessage` is `true`), drops all messages between the system message and the last `preserveRecentCount` messages, and keeps those recent messages intact.

This works well for agents where recent context matters most. Early tool call results and intermediate reasoning steps get dropped, but the agent retains its instructions and recent conversation thread.

## Built-in: noop strategy

If you don't want any compaction—say you're using a model with a massive context window and you'd rather hit the API limit than lose context—use the pass-through strategy:

```typescript
import { noopStrategy } from 'weft';

const contextManager = new ContextWindowManager({
  maxTokens: 1_000_000,
  strategy: noopStrategy(),
});
```

This is also the default if you don't specify a strategy. The manager will still track token counts and report when compaction _would_ be triggered, but `compact()` returns the messages unchanged.

## Composing strategies

For more sophisticated approaches, compose multiple strategies in sequence:

```typescript
import { composeStrategies, slidingWindowStrategy } from 'weft';

const strategy = composeStrategies(
  slidingWindowStrategy({ preserveRecentCount: 30 }), // First pass: broad window
  slidingWindowStrategy({ preserveRecentCount: 20 }), // Second pass: tighter window
);
```

`composeStrategies()` runs each strategy in order, passing the output of one as the input to the next. The first pass can keep a broader slice of recent context, while the second pass tightens that window if the conversation still needs compaction. Each step is a potential checkpoint boundary, so the engine can persist intermediate results.

## Writing a custom strategy

Implement the `ContextStrategy` interface to build your own:

```typescript
import type { ContextStrategy, CompactOptions } from 'weft';
import type { Message } from 'weft';

function summarizeOldMessages(): ContextStrategy {
  return {
    name: 'summarize-old-messages',
    async *compact(
      messages: Message[],
      options: CompactOptions,
    ): AsyncGenerator<Message[], Message[], unknown> {
      const system = messages[0]?.role === 'system' ? messages[0] : null;
      const rest = system ? messages.slice(1) : messages;

      if (rest.length <= 5) {
        yield messages;
        return messages;
      }

      // Keep the 5 most recent messages, summarize the rest
      const old = rest.slice(0, -5);
      const recent = rest.slice(-5);
      const summary = old.map((m) => `${m.role}: ${m.content.slice(0, 100)}`).join('\n');
      const summaryMessage: Message = {
        role: 'user',
        content: `[Previous conversation summary]\n${summary}`,
      };

      const result = system ? [system, summaryMessage, ...recent] : [summaryMessage, ...recent];

      yield result;
      return result;
    },
  };
}
```

The key requirements: yield your compacted messages at least once, and return them. The engine uses the yielded value.

## How context state survives checkpoints

The `ContextWindowManager` keeps a single piece of state—the most recent compacted message list. It exposes `checkpoint()`, `restore()`, `getCompactedMessages()`, and `clearCompactedMessages()` so the agent loop can persist and reload this state across crashes. When a workflow resumes after a crash, calling `restore(checkpoint)` reloads the already-compacted conversation so the manager doesn't re-compact unnecessarily.

Context management is one of those things you don't think about until turn 30, and then it's the only thing you think about. Set up a strategy early—your agents will run longer and your bills will be smaller.
