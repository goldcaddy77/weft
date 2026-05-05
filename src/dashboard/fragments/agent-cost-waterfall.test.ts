import { describe, expect, it } from 'bun:test';

import {
  buildTurnUsageRows,
  buildTurnUsageRowsFromTurnData,
  type TurnUsageEntry,
} from './agent-cost-waterfall';
import type { AgentTurnData } from './agent-turn-types.ts';

function makeEntry(
  turnNumber: number,
  inputTokens: number | null,
  outputTokens: number | null,
  source: 'provider' | 'unavailable',
): TurnUsageEntry {
  return { turnNumber, inputTokens, outputTokens, source };
}

function makeTurn(turnIndex: number, inputTokens: number, outputTokens: number): AgentTurnData {
  return {
    turnIndex,
    model: 'claude',
    inputTokens,
    outputTokens,
    toolCalls: [],
    response: '',
    messages: [],
    reasoningTrace: '',
  };
}

describe('buildTurnUsageRows', () => {
  it('returns an empty array for no entries', () => {
    expect(buildTurnUsageRows([])).toEqual([]);
  });

  it('maps provider entries with numeric tokens', () => {
    const rows = buildTurnUsageRows([makeEntry(0, 120, 80, 'provider')]);
    expect(rows).toEqual([
      { turnNumber: 0, inputTokens: 120, outputTokens: 80, unavailable: false },
    ]);
  });

  it('marks unavailable entries with null tokens and unavailable flag', () => {
    const rows = buildTurnUsageRows([makeEntry(1, null, null, 'unavailable')]);
    expect(rows).toEqual([
      { turnNumber: 1, inputTokens: null, outputTokens: null, unavailable: true },
    ]);
  });

  it('handles mixed provider and unavailable entries', () => {
    const entries: TurnUsageEntry[] = [
      makeEntry(0, 100, 50, 'provider'),
      makeEntry(1, null, null, 'unavailable'),
      makeEntry(2, 200, 100, 'provider'),
    ];
    const rows = buildTurnUsageRows(entries);
    expect(rows[0]?.unavailable).toBe(false);
    expect(rows[1]?.unavailable).toBe(true);
    expect(rows[2]?.unavailable).toBe(false);
  });
});

describe('buildTurnUsageRowsFromTurnData', () => {
  it('returns an empty array for no turns', () => {
    expect(buildTurnUsageRowsFromTurnData([])).toEqual([]);
  });

  it('maps turn data to rows', () => {
    const rows = buildTurnUsageRowsFromTurnData([makeTurn(0, 120, 80)]);
    expect(rows).toEqual([
      { turnNumber: 0, inputTokens: 120, outputTokens: 80, unavailable: false },
    ]);
  });

  it('marks turns with zero tokens as unavailable', () => {
    const rows = buildTurnUsageRowsFromTurnData([makeTurn(1, 0, 0)]);
    expect(rows[0]?.unavailable).toBe(true);
  });
});
