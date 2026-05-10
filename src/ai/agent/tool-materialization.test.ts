import { describe, expect, it } from 'bun:test';

import { materializeToolCall, materializeToolResult } from './tool-materialization.ts';

describe('tool materialization', () => {
  it('preserves explicit null tool-call arguments', () => {
    const toolCall = materializeToolCall({
      id: 'call-1',
      name: 'nullable_arguments',
      arguments: null,
    });

    expect(toolCall).toEqual({
      id: 'call-1',
      name: 'nullable_arguments',
      arguments: null,
    });
  });

  it('preserves empty-string result metadata', () => {
    const result = materializeToolResult({
      callId: 'call-1',
      outcome: 'action_required',
      content: null,
      action: {
        type: 'input',
        message: '',
      },
      inputDigest: '',
      outputDigest: '',
    });

    expect(result).toEqual({
      callId: 'call-1',
      outcome: 'action_required',
      content: null,
      action: {
        type: 'input',
        message: '',
      },
      inputDigest: '',
      outputDigest: '',
    });
  });
});
