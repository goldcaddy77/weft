/**
 * Saga primitive integration tests.
 *
 * Verifies that `ctx.saga()` runs steps in order and, on failure, executes
 * compensators for completed steps in reverse order — each exactly once —
 * including across an engine restart (recovery).
 *
 * @module core/__tests__/saga
 */

import { describe, expect, it } from 'bun:test';

import { TestEngine } from '../../testing/test-engine.ts';
import type { Context, SagaActivityShape } from '../context.ts';
import type { WorkflowContext } from '../types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function flush(): Promise<void> {
  await Bun.sleep(10);
}

// ---------------------------------------------------------------------------
// Shared activity definitions and call counters
//
// These are module-level so that activity functions have stable identities
// across workflow registrations and engine restarts within a single test.
// Each test resets the counters before running.
// ---------------------------------------------------------------------------

let step1RunCount = 0;
let step2RunCount = 0;
let step3RunCount = 0;
let step1CompensateCount = 0;
let step2CompensateCount = 0;

function resetCounters(): void {
  step1RunCount = 0;
  step2RunCount = 0;
  step3RunCount = 0;
  step1CompensateCount = 0;
  step2CompensateCount = 0;
}

const reserveInventory: SagaActivityShape = {
  name: 'reserveInventory',
  execute: async (input) => {
    const { sku } = input as { sku: string };
    step1RunCount++;
    return { reservationId: `res:${sku}` };
  },
  compensate: async (_input, _output) => {
    step1CompensateCount++;
    // would call e.g. inventory.cancel((output as Step1Output).reservationId)
  },
};

const chargeCard: SagaActivityShape = {
  name: 'chargeCard',
  execute: async (input) => {
    const { amount } = input as { amount: number };
    step2RunCount++;
    return { chargeId: `ch:${amount}` };
  },
  compensate: async (_input, _output) => {
    step2CompensateCount++;
    // would call e.g. stripe.refunds.create({ charge: (output as Step2Output).chargeId })
  },
};

const scheduleShipment: SagaActivityShape = {
  name: 'scheduleShipment',
  execute: async (input) => {
    const { orderId } = input as { orderId: string };
    step3RunCount++;
    throw new Error(`Shipment service unavailable for order ${orderId}`);
  },
  // No compensate — step 3 failed before completing, so nothing to undo.
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ctx.saga()', () => {
  it('runs all steps in order when none fail', async () => {
    resetCounters();

    const engine = new TestEngine();

    engine.register('happy-path', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).saga([
        { activity: reserveInventory, input: { sku: 'WIDGET-1' } },
        { activity: chargeCard, input: { amount: 99 } },
      ]);
      return 'done';
    });

    const handle = await engine.start('happy-path', null);
    const result = await handle.result();

    expect(result).toBe('done');
    expect(step1RunCount).toBe(1);
    expect(step2RunCount).toBe(1);
    expect(step1CompensateCount).toBe(0);
    expect(step2CompensateCount).toBe(0);

    engine[Symbol.dispose]();
  });

  it('runs compensators in reverse order when a step fails', async () => {
    resetCounters();

    const engine = new TestEngine();
    const compensationOrder: string[] = [];

    const activityA: SagaActivityShape = {
      name: 'activityA',
      execute: async (input) => ({ id: `a:${input as string}` }),
      compensate: async () => {
        compensationOrder.push('A');
      },
    };

    const activityB: SagaActivityShape = {
      name: 'activityB',
      execute: async (input) => ({ id: `b:${input as string}` }),
      compensate: async () => {
        compensationOrder.push('B');
      },
    };

    const activityC: SagaActivityShape = {
      name: 'activityC',
      execute: async () => {
        throw new Error('C always fails');
      },
    };

    engine.register('reverse-order', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).saga([
        { activity: activityA, input: 'x' },
        { activity: activityB, input: 'y' },
        { activity: activityC, input: 'z' },
      ]);
    });

    const handle = await engine.start('reverse-order', null);
    await expect(handle.result()).rejects.toThrow('C always fails');

    // B compensated before A (reverse order)
    expect(compensationOrder).toEqual(['B', 'A']);

    engine[Symbol.dispose]();
  });

  it('3-step saga: step 3 fails; compensators for step 1 and step 2 run exactly once each, verified across engine restart', async () => {
    resetCounters();

    const engine = new TestEngine();

    engine.register('order-saga', async function* (ctx: WorkflowContext, input: unknown) {
      const orderId = input as string;
      yield* (ctx as Context).saga([
        { activity: reserveInventory, input: { sku: 'WIDGET-1' } },
        { activity: chargeCard, input: { amount: 99 } },
        { activity: scheduleShipment, input: { orderId } },
      ]);
    });

    const handle = await engine.start('order-saga', 'order-42', {
      id: 'saga-3step-test',
    });

    // The workflow should fail because step 3 throws.
    await expect(handle.result()).rejects.toThrow('Shipment service unavailable');

    await flush();

    // Verify activity + compensator call counts on the original engine.
    expect(step1RunCount).toBe(1);
    expect(step2RunCount).toBe(1);
    expect(step3RunCount).toBe(1);
    expect(step2CompensateCount).toBe(1); // step 2 compensated first (reverse)
    expect(step1CompensateCount).toBe(1); // step 1 compensated second

    // -----------------------------------------------------------------------
    // Engine restart: create a recovered engine backed by the same storage.
    // Re-register the workflow on the new engine and verify that:
    //   1. The workflow state is 'failed' (compensation ran, then error propagated)
    //   2. Activity + compensator call counts did NOT increment again
    //      (the engine does not re-execute completed steps on replay).
    // -----------------------------------------------------------------------

    const recoveredEngine = engine.recover();

    recoveredEngine.register('order-saga', async function* (ctx: WorkflowContext, input: unknown) {
      const orderId = input as string;
      yield* (ctx as Context).saga([
        { activity: reserveInventory, input: { sku: 'WIDGET-1' } },
        { activity: chargeCard, input: { amount: 99 } },
        { activity: scheduleShipment, input: { orderId } },
      ]);
    });

    await flush();

    const workflowState = await recoveredEngine.get('saga-3step-test');
    expect(workflowState?.status).toBe('failed');

    // Call counts must not have increased — the recovered engine should
    // consume results from the checkpoint, not re-execute side effects.
    expect(step1RunCount).toBe(1);
    expect(step2RunCount).toBe(1);
    expect(step3RunCount).toBe(1);
    expect(step2CompensateCount).toBe(1);
    expect(step1CompensateCount).toBe(1);

    engine[Symbol.dispose]();
    recoveredEngine[Symbol.dispose]();
  });

  it('does not run compensators when all steps succeed', async () => {
    resetCounters();

    const engine = new TestEngine();

    engine.register('success-saga', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).saga([
        { activity: reserveInventory, input: { sku: 'SKU-X' } },
        { activity: chargeCard, input: { amount: 50 } },
      ]);
      return 'success';
    });

    const handle = await engine.start('success-saga', null);
    await handle.result();

    expect(step1CompensateCount).toBe(0);
    expect(step2CompensateCount).toBe(0);

    engine[Symbol.dispose]();
  });

  it('skips compensation for steps without a compensate handler', async () => {
    resetCounters();

    const engine = new TestEngine();
    let compensated = false;

    const stepWithoutCompensator: SagaActivityShape = {
      name: 'stepWithoutCompensator',
      execute: async (input) => (input as string).toUpperCase(),
      // No compensate field
    };

    const stepWithCompensator: SagaActivityShape = {
      name: 'stepWithCompensator',
      execute: async (input) => (input as string).toLowerCase(),
      compensate: async () => {
        compensated = true;
      },
    };

    const alwaysFails: SagaActivityShape = {
      name: 'alwaysFails',
      execute: async () => {
        throw new Error('intentional failure');
      },
    };

    engine.register('partial-compensators', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).saga([
        { activity: stepWithoutCompensator, input: 'hello' },
        { activity: stepWithCompensator, input: 'WORLD' },
        { activity: alwaysFails, input: 'x' },
      ]);
    });

    const handle = await engine.start('partial-compensators', null);
    await expect(handle.result()).rejects.toThrow('intentional failure');

    // stepWithCompensator ran second and should be compensated;
    // stepWithoutCompensator ran first but has no compensator — no error.
    expect(compensated).toBe(true);

    engine[Symbol.dispose]();
  });
});
