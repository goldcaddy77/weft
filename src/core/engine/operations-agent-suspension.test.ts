import { describe, expect, it } from 'bun:test';

import {
  isPersistedAgentLoopStateValue,
  VersionMismatchError,
} from './operations-agent-suspension.ts';

async function loadFixture(name: string): Promise<unknown> {
  return Bun.file(new URL(`../../ai/agent/__fixtures__/${name}`, import.meta.url)).json();
}

describe('persisted agent loop state version validation', () => {
  it('rejects v1 persisted state with a forbidden field', async () => {
    const value = await loadFixture('persisted-state-v1.json');

    expect(() => isPersistedAgentLoopStateValue(value)).toThrow(VersionMismatchError);

    try {
      isPersistedAgentLoopStateValue(value);
    } catch (error) {
      expect(error).toBeInstanceOf(VersionMismatchError);
      expect((error as VersionMismatchError).offendingField).toBe('toolCacheEntries');
      expect((error as Error).message).toContain('toolCacheEntries');
    }
  });

  it('accepts v2 persisted state', async () => {
    const value = await loadFixture('persisted-state-v2.json');

    expect(isPersistedAgentLoopStateValue(value)).toBe(true);
  });

  it('rejects v1 state where previousModels is the only forbidden field', () => {
    const value = { schemaVersion: 1, previousModels: [] };

    expect(() => isPersistedAgentLoopStateValue(value)).toThrow(VersionMismatchError);

    try {
      isPersistedAgentLoopStateValue(value);
    } catch (error) {
      expect(error).toBeInstanceOf(VersionMismatchError);
      expect((error as VersionMismatchError).offendingField).toBe('previousModels');
      expect((error as Error).message).toContain('previousModels');
    }
  });

  it('rejects v1 state where budgetState is the only forbidden field', () => {
    const value = { schemaVersion: 1, budgetState: null };

    expect(() => isPersistedAgentLoopStateValue(value)).toThrow(VersionMismatchError);

    try {
      isPersistedAgentLoopStateValue(value);
    } catch (error) {
      expect(error).toBeInstanceOf(VersionMismatchError);
      expect((error as VersionMismatchError).offendingField).toBe('budgetState');
      expect((error as Error).message).toContain('budgetState');
    }
  });
});
