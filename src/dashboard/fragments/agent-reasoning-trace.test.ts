import { describe, expect, it } from 'bun:test';

import { buildReasoningEntries } from './agent-reasoning-trace';
import type { AgentTurnData } from './agent-turn-types.ts';

function makeTurn(turnIndex: number, reasoningTrace: string, model = 'claude'): AgentTurnData {
  return {
    turnIndex,
    model,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: [],
    response: '',
    messages: [],
    reasoningTrace,
  };
}

describe('buildReasoningEntries', () => {
  it('returns an empty array when there are no turns', () => {
    expect(buildReasoningEntries([])).toEqual([]);
  });

  it('returns an empty array when every trace is empty', () => {
    expect(buildReasoningEntries([makeTurn(0, ''), makeTurn(1, '')])).toEqual([]);
  });

  it('keeps turns with non-empty traces and preserves order', () => {
    const entries = buildReasoningEntries([
      makeTurn(0, 'first thought'),
      makeTurn(1, ''),
      makeTurn(2, 'third thought', 'gpt-4'),
    ]);
    expect(entries.length).toBe(2);
    expect(entries[0]).toEqual({ turnIndex: 0, model: 'claude', trace: 'first thought' });
    expect(entries[1]).toEqual({ turnIndex: 2, model: 'gpt-4', trace: 'third thought' });
  });

  it('filters whitespace-only traces', () => {
    const entries = buildReasoningEntries([makeTurn(0, '   \n\t  '), makeTurn(1, 'real trace')]);
    expect(entries.length).toBe(1);
    expect(entries[0]?.trace).toBe('real trace');
  });
});
