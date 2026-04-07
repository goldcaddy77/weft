import { describe, expect, it } from 'bun:test';

import type { Message } from '../../ai/providers/types.ts';
import { groupConversationMessages } from './agent-conversation';
import type { AgentTurnData } from './agent-turn-types.ts';

function makeTurn(turnIndex: number, messages: Message[]): AgentTurnData {
  return {
    turnIndex,
    model: 'claude',
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    toolCalls: [],
    response: '',
    messages,
    reasoningTrace: '',
  };
}

describe('groupConversationMessages', () => {
  it('returns an empty array when there are no turns', () => {
    expect(groupConversationMessages([])).toEqual([]);
  });

  it('returns the full snapshot for a single turn', () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const groups = groupConversationMessages([makeTurn(0, messages)]);
    expect(groups.length).toBe(1);
    expect(groups[0]?.messages).toEqual(messages);
  });

  it('segments multi-turn snapshots by delta so prefixes are not duplicated', () => {
    const turn0Messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first user' },
      { role: 'assistant', content: 'first assistant' },
    ];
    const turn1Messages: Message[] = [
      ...turn0Messages,
      { role: 'user', content: 'second user' },
      { role: 'assistant', content: 'second assistant' },
    ];
    const groups = groupConversationMessages([
      makeTurn(0, turn0Messages),
      makeTurn(1, turn1Messages),
    ]);
    expect(groups.length).toBe(2);
    expect(groups[0]?.messages.map((message) => message.content)).toEqual([
      'sys',
      'first user',
      'first assistant',
    ]);
    expect(groups[1]?.messages.map((message) => message.content)).toEqual([
      'second user',
      'second assistant',
    ]);
  });

  it('falls back to per-turn arrays when the last turn has an empty snapshot', () => {
    const groups = groupConversationMessages([
      makeTurn(0, [{ role: 'user', content: 'hi' }]),
      makeTurn(1, []),
    ]);
    expect(groups.length).toBe(2);
    expect(groups[0]?.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(groups[1]?.messages).toEqual([]);
  });
});
