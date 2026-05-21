import { describe, expect, it } from 'bun:test';

import { Engine } from '../engine.ts';
import { workflow } from '../types.ts';
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

    const migratedWorkflow = workflow({
      name: 'migrated-workflow',
      migrate,
      version: '2',
    }).execute(async function* () {
      return 'done';
    });
    engine.register(migratedWorkflow);

    expect(getInternals(engine).registrations.get('migrated-workflow')?.migrate).toBe(migrate);

    engine[Symbol.dispose]();
  });
});
