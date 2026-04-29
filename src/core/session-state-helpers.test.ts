import { describe, expect, it } from 'bun:test';

import {
  assertValidSessionStateKey,
  createSessionStateStore,
  MAX_SESSION_STATE_ENTRY_COUNT,
  MAX_SESSION_STATE_KEY_LENGTH,
  MAX_SESSION_STATE_SERIALIZED_BYTES,
  normalizeSessionStateRecord,
  SessionStateValidationError,
  validateSessionStateStore,
} from './session-state.ts';

describe('session-state helpers', () => {
  it('rejects empty and oversized keys', () => {
    expect(() => assertValidSessionStateKey('')).toThrow(SessionStateValidationError);
    expect(() => assertValidSessionStateKey('x'.repeat(MAX_SESSION_STATE_KEY_LENGTH + 1))).toThrow(
      /1-256 characters long/,
    );
  });

  it('rejects reserved keys', () => {
    expect(() => assertValidSessionStateKey('__proto__')).toThrow(/is reserved/);
  });

  it('normalizes undefined and empty records to undefined', () => {
    expect(normalizeSessionStateRecord(undefined)).toBeUndefined();
    expect(normalizeSessionStateRecord({})).toBeUndefined();
  });

  it('rejects records with too many entries during normalization', () => {
    const oversized = Object.fromEntries(
      Array.from({ length: MAX_SESSION_STATE_ENTRY_COUNT + 1 }, (_value, index) => [
        `key-${String(index)}`,
        index,
      ]),
    );

    expect(() => normalizeSessionStateRecord(oversized)).toThrow(
      `Session state may not contain more than ${String(MAX_SESSION_STATE_ENTRY_COUNT)} keys.`,
    );
  });

  it('rejects stores with too many entries during validation', () => {
    const store = createSessionStateStore();
    for (let index = 0; index <= MAX_SESSION_STATE_ENTRY_COUNT; index += 1) {
      store[`key-${String(index)}`] = index;
    }

    expect(() => validateSessionStateStore(store)).toThrow(
      `Session state may not contain more than ${String(MAX_SESSION_STATE_ENTRY_COUNT)} keys.`,
    );
  });

  it('rejects stores whose serialized form exceeds the size limit', () => {
    const store = createSessionStateStore();
    store['large'] = 'x'.repeat(MAX_SESSION_STATE_SERIALIZED_BYTES);

    expect(() => validateSessionStateStore(store)).toThrow(
      `Session state exceeds the ${String(MAX_SESSION_STATE_SERIALIZED_BYTES)} byte limit.`,
    );
  });
});
