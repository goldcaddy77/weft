import { describe, expect, it } from 'bun:test';

import { Engine } from '../engine.ts';
import { getInternals } from './internals.ts';
import { resolveWorkflowTypeTarget, type RegistrationCallbacks } from './registration.ts';

const callbacks: RegistrationCallbacks = {
  ensureRetentionSweepInterval: () => undefined,
};

describe('resolveWorkflowTypeTarget', () => {
  it('returns string workflow targets directly', () => {
    const engine = new Engine();

    expect(resolveWorkflowTypeTarget(getInternals(engine), 'registered-workflow', callbacks)).toBe(
      'registered-workflow',
    );

    engine[Symbol.dispose]();
  });

  it('preserves migration functions on registration entries', () => {
    const engine = new Engine();
    const migrate = (checkpoint: unknown) => checkpoint;

    engine.register('migrated-workflow', {
      handler: async function* () {
        return 'done';
      },
      migrate,
      version: '2',
    });

    expect(getInternals(engine).registrations.get('migrated-workflow')?.migrate).toBe(migrate);

    engine[Symbol.dispose]();
  });
});
