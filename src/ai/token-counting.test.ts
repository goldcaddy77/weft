import { describe, expect, it } from 'bun:test';

import type { Message } from './providers/types.ts';
import { estimateTokens } from './token-counting.ts';

function createMessage(role: Message['role'], content: string): Message {
  return { role, content };
}

describe('estimateTokens', () => {
  it('returns 0 for an empty array', () => {
    expect(estimateTokens([])).toBe(0);
  });

  it('estimates English text at roughly 4 characters per token plus overhead', () => {
    // "Hello world" = 11 chars -> ceil(11/4) = 3 content tokens + 3 overhead = 6
    const messages = [createMessage('user', 'Hello world')];
    expect(estimateTokens(messages)).toBe(6);
  });

  it('sums tokens across multiple messages', () => {
    const messages = [
      createMessage('user', 'Hello world'), // ceil(11/4) = 3 + 3 overhead = 6
      createMessage('assistant', 'Hi there'), // ceil(8/4) = 2 + 3 overhead = 5
    ];
    expect(estimateTokens(messages)).toBe(11);
  });

  it('counts system prompt tokens', () => {
    const messages = [
      createMessage('system', 'You are a helpful assistant.'), // ceil(28/4) = 7 + 3 = 10
      createMessage('user', 'Hi'), // ceil(2/4) = 1 + 3 = 4
    ];
    expect(estimateTokens(messages)).toBe(14);
  });

  it('handles messages with empty content', () => {
    // Empty content = 0 content tokens + 3 overhead = 3
    const messages = [createMessage('user', '')];
    expect(estimateTokens(messages)).toBe(3);
  });

  it('handles long messages', () => {
    const longContent = 'a'.repeat(1000);
    const messages = [createMessage('user', longContent)];
    // 1000 chars / 4 = 250 content tokens + 3 overhead = 253
    expect(estimateTokens(messages)).toBe(253);
  });

  it('rounds up partial tokens', () => {
    // "Hi!" = 3 chars -> ceil(3/4) = 1 content token + 3 overhead = 4
    const messages = [createMessage('user', 'Hi!')];
    expect(estimateTokens(messages)).toBe(4);
  });

  it('adds per-message overhead for role/framing', () => {
    // Each message gets a small overhead (3 tokens) for role/framing
    // Single message with empty content: 0 content tokens + 3 overhead = 3
    const singleEmpty = [createMessage('user', '')];
    const twoEmpty = [createMessage('user', ''), createMessage('assistant', '')];

    expect(estimateTokens(singleEmpty)).toBe(3);
    expect(estimateTokens(twoEmpty)).toBe(6);
    expect(estimateTokens(twoEmpty)).toBeGreaterThan(estimateTokens(singleEmpty));
  });
});
