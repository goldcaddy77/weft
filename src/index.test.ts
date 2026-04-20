import { describe, expect, it } from 'bun:test';

import type { WorkflowOperation } from './index';
import { Engine, MemoryStorage, VERSION, WorkflowAlreadyExistsError } from './index';

describe('weft', () => {
  it('exports a version string', () => {
    expect(VERSION).toBe('0.0.1');
  });

  it('exports Engine class', () => {
    expect(Engine).toBeDefined();
  });

  it('exports MemoryStorage class', () => {
    expect(MemoryStorage).toBeDefined();
  });

  it('exports WorkflowOperation type', () => {
    const operation: WorkflowOperation<string> | undefined = undefined;
    expect(operation).toBeUndefined();
  });

  it('exports WorkflowAlreadyExistsError for duplicate workflow ids', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engine.register('duplicate-id', async function* () {
      return 'ok';
    });

    try {
      await engine.start('duplicate-id', null, { id: 'duplicate-id' });
      await expect(engine.start('duplicate-id', null, { id: 'duplicate-id' })).rejects.toBeInstanceOf(
        WorkflowAlreadyExistsError,
      );
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });
});
