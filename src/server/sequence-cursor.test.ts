import { describe, expect, it } from 'bun:test';

import { parseOptionalSequenceCursor } from './sequence-cursor.ts';

describe('parseOptionalSequenceCursor', () => {
  it('returns an empty result when the cursor is omitted', () => {
    expect(parseOptionalSequenceCursor(undefined, 'after')).toEqual({});
    expect(parseOptionalSequenceCursor(null, 'after')).toEqual({});
  });

  it('rejects empty, non-decimal, and out-of-range cursors', () => {
    expect(parseOptionalSequenceCursor('', 'after')).toEqual({
      error: 'Invalid after: ',
    });
    expect(parseOptionalSequenceCursor('  ', 'after')).toEqual({
      error: 'Invalid after:   ',
    });
    expect(parseOptionalSequenceCursor('1.5', 'after')).toEqual({
      error: 'Invalid after: 1.5',
    });
    expect(parseOptionalSequenceCursor('-2', 'after')).toEqual({
      error: 'Invalid after: -2',
    });
  });

  it('accepts safe integers including the sentinel -1', () => {
    expect(parseOptionalSequenceCursor('-1', 'after')).toEqual({ value: -1 });
    expect(parseOptionalSequenceCursor('42', 'after')).toEqual({ value: 42 });
  });
});

it('All live views share the same sequence and cursor semantics. Replay, resume, and ordering rules are identical across HTTP, WebSocket, and the Track 8 runtime stdio JSON-RPC transport.', () => {
  expect(parseOptionalSequenceCursor('42', 'after')).toEqual({ value: 42 });
  expect(parseOptionalSequenceCursor('42', 'before')).toEqual({ value: 42 });
});
