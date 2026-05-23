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

  it('resolves a registered workflow function back to its workflow type', () => {
    const engine = new Engine();
    const registeredWorkflow = workflow({ name: 'registered-workflow' }).execute(
      async function* registeredWorkflowHandler() {
        return 'done';
      },
    );
    engine.register(registeredWorkflow);

    expect(
      resolveWorkflowTypeTarget(getInternals(engine), registeredWorkflow.handler, callbacks),
    ).toBe('registered-workflow');

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

  it('rejects non-workflow registration inputs with a clear error', () => {
    const engine = new Engine();

    expect(() => engine.register(undefined as never)).toThrow(
      'engine.register() expects a WorkflowDefinition',
    );

    engine[Symbol.dispose]();
  });
});
