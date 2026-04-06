import { describe, expect, it } from 'bun:test';

import type { Message } from '../providers/types.ts';
import type { VectorStore } from './rag.ts';
import { createRAGStrategy } from './rag.ts';

function createMessage(role: Message['role'], content: string): Message {
  return { role, content };
}

function createMessages(count: number, options?: { withSystem?: boolean }): Message[] {
  const messages: Message[] = [];
  if (options?.withSystem) {
    messages.push(createMessage('system', 'You are a helpful assistant.'));
  }
  for (let i = 0; i < count; i++) {
    messages.push(createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`));
  }
  return messages;
}

function createMockVectorStore(chunks: string[]): VectorStore {
  return {
    search: async (_query: string, _topK: number) => chunks,
  };
}

const defaultOptions = {
  maxTokens: 1000,
  reservedForOutput: 250,
  currentTokenCount: 500,
};

describe('createRAGStrategy', () => {
  it('replaces full history with system prompt + retrieved context + recent messages', async () => {
    const vectorStore = createMockVectorStore(['Relevant chunk 1', 'Relevant chunk 2']);
    const strategy = createRAGStrategy({ vectorStore, topK: 2, keepRecent: 3 });

    const messages = createMessages(10, { withSystem: true });
    const generator = strategy.compact(messages, defaultOptions);
    const result = await generator.next();
    const compacted = result.value;

    // System prompt + context message + last 3 non-system messages = 5
    expect(compacted).toHaveLength(5);
    expect(compacted[0]!.role).toBe('system');
    expect(compacted[0]!.content).toBe('You are a helpful assistant.');
    expect(compacted[1]!.role).toBe('system');
    expect(compacted[1]!.content).toContain('Relevant chunk 1');
    expect(compacted[1]!.content).toContain('Relevant chunk 2');
    expect(compacted.slice(-3)).toEqual(messages.slice(-3));
  });

  it('queries vector store with content from recent messages', async () => {
    let receivedQuery = '';
    let receivedTopK = 0;
    const vectorStore: VectorStore = {
      search: async (query: string, topK: number) => {
        receivedQuery = query;
        receivedTopK = topK;
        return ['chunk'];
      },
    };

    const strategy = createRAGStrategy({ vectorStore, topK: 5, keepRecent: 2 });
    const messages = createMessages(10, { withSystem: true });

    const generator = strategy.compact(messages, defaultOptions);
    await generator.next();

    // Query should contain content from recent messages
    expect(receivedQuery).toContain('Message 8');
    expect(receivedQuery).toContain('Message 9');
    expect(receivedTopK).toBe(5);
  });

  it('preserves system prompt', async () => {
    const vectorStore = createMockVectorStore(['chunk']);
    const strategy = createRAGStrategy({ vectorStore, topK: 1, keepRecent: 2 });

    const messages = createMessages(8, { withSystem: true });
    const generator = strategy.compact(messages, defaultOptions);
    const result = await generator.next();
    const compacted = result.value;

    expect(compacted[0]!.role).toBe('system');
    expect(compacted[0]!.content).toBe('You are a helpful assistant.');
  });

  it('preserves recent messages', async () => {
    const vectorStore = createMockVectorStore(['chunk']);
    const strategy = createRAGStrategy({ vectorStore, topK: 1, keepRecent: 4 });

    const messages = createMessages(10, { withSystem: true });
    const generator = strategy.compact(messages, defaultOptions);
    const result = await generator.next();
    const compacted = result.value;

    const expectedRecent = messages.slice(-4);
    expect(compacted.slice(-4)).toEqual(expectedRecent);
  });

  it('works without a system prompt', async () => {
    const vectorStore = createMockVectorStore(['chunk A', 'chunk B']);
    const strategy = createRAGStrategy({ vectorStore, topK: 2, keepRecent: 2 });

    const messages = createMessages(8); // no system
    const generator = strategy.compact(messages, defaultOptions);
    const result = await generator.next();
    const compacted = result.value;

    // Context message + last 2 = 3
    expect(compacted).toHaveLength(3);
    expect(compacted[0]!.role).toBe('system');
    expect(compacted[0]!.content).toContain('chunk A');
    expect(compacted[0]!.content).toContain('chunk B');
    expect(compacted.slice(-2)).toEqual(messages.slice(-2));
  });

  it('returns all messages when count is under keepRecent', async () => {
    let searchCalled = false;
    const vectorStore: VectorStore = {
      search: async () => {
        searchCalled = true;
        return ['chunk'];
      },
    };

    const strategy = createRAGStrategy({ vectorStore, topK: 3, keepRecent: 20 });
    const messages = createMessages(5, { withSystem: true });

    const generator = strategy.compact(messages, defaultOptions);
    const result = await generator.next();

    expect(result.value).toEqual(messages);
    expect(searchCalled).toBe(false);
  });

  it('handles empty messages', async () => {
    const vectorStore = createMockVectorStore(['chunk']);
    const strategy = createRAGStrategy({ vectorStore, topK: 1, keepRecent: 5 });

    const generator = strategy.compact([], defaultOptions);
    const result = await generator.next();
    expect(result.value).toEqual([]);
  });

  it('handles empty vector store results', async () => {
    const vectorStore = createMockVectorStore([]);
    const strategy = createRAGStrategy({ vectorStore, topK: 5, keepRecent: 2 });

    const messages = createMessages(10, { withSystem: true });
    const generator = strategy.compact(messages, defaultOptions);
    const result = await generator.next();
    const compacted = result.value;

    // System prompt + last 2 (no context message when no chunks returned)
    expect(compacted).toHaveLength(3);
    expect(compacted[0]!.role).toBe('system');
    expect(compacted[0]!.content).toBe('You are a helpful assistant.');
    expect(compacted.slice(-2)).toEqual(messages.slice(-2));
  });
});
