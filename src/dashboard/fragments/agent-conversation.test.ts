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

  it('records an empty group for an intermediate turn with a missing snapshot', () => {
    // Turn 1 has no snapshot (legacy event) but turns 0 and 2 do, so the final
    // turn snapshot is non-empty. The function must NOT fall back to the
    // per-turn path — it should push an empty group for the middle turn and
    // continue computing deltas from the adjacent turns' counts.
    const turn0Messages: Message[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
    ];
    const turn2Messages: Message[] = [
      ...turn0Messages,
      { role: 'user', content: 'third' },
      { role: 'assistant', content: 'final' },
    ];
    const groups = groupConversationMessages([
      makeTurn(0, turn0Messages),
      makeTurn(1, []),
      makeTurn(2, turn2Messages),
    ]);
    expect(groups.length).toBe(3);
    // Turn 0: all its own messages.
    expect(groups[0]?.messages.map((m) => m.content)).toEqual(['first', 'reply']);
    // Turn 1: empty because the intermediate snapshot is missing.
    expect(groups[1]?.messages).toEqual([]);
    // Turn 2: delta from turn0 length (2) to turn2 length (4).
    expect(groups[2]?.messages.map((m) => m.content)).toEqual(['third', 'final']);
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
