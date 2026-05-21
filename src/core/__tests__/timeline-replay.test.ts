import { afterEach, describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { encode } from '../codec.ts';
import { Engine } from '../engine.ts';
import { workflow, type WorkflowContext } from '../types.ts';

describe('timeline and replay', () => {
  let engine: Engine;

  afterEach(() => {
    engine[Symbol.dispose]();
  });

  it('acceptance criterion: engine.getTimeline(workflowId) returns structured timeline entries for each durable step', async () => {
    let now = 1_000;
    const storage = new MemoryStorage();

    async function loadOrder(input: unknown) {
      const { orderId } = input as { authorization: string; orderId: string };
      now += 25;
      return { accessToken: 'Bearer result-secret', orderId, status: 'loaded' as const };
    }

    async function chargeCard(input: unknown) {
      const { amount, orderId } = input as {
        amount: number;
        cardNumber: string;
        orderId: string;
      };
      now += 40;
      return { amount, cardNumber: '4111 1111 1111 1111', chargeId: 'pay-123', orderId };
    }

    engine = new Engine({ storage, checkpointHistory: 10, getNow: () => now });
    const checkoutWorkflow = workflow({ name: 'checkout', version: '2.0.0' }).execute(
      async function* (ctx: WorkflowContext) {
        const order = yield* ctx.run(loadOrder, {
          authorization: 'Bearer customer-secret',
          orderId: 'order-1',
        });
        return yield* ctx.run(chargeCard, {
          amount: 42,
          cardNumber: '4111111111111111',
          orderId: order.orderId,
        });
      },
    );
    engine.register(checkoutWorkflow);

    const handle = await engine.start('checkout', null, { id: 'wf-timeline' });
    await handle.result();

    const timeline = await engine.getTimeline('wf-timeline');

    expect(timeline).toHaveLength(2);
    expect(timeline[0]).toMatchObject({
      step: 1,
      operationType: 'activity',
      operationLabel: 'loadOrder',
      duration: 25,
      status: 'completed',
      versionTuple: { workflowVersion: '2.0.0' },
    });
    expect(timeline[0]?.inputSummary).toContain('"orderId":"order-1"');
    expect(timeline[0]?.inputSummary).toContain('"authorization":"[REDACTED]"');
    expect(timeline[0]?.outputSummary).toContain('"accessToken":"[REDACTED]"');
    expect(timeline[0]!.timestamp).toBe(1_000);

    expect(timeline[1]).toMatchObject({
      step: 2,
      operationType: 'activity',
      operationLabel: 'chargeCard',
      duration: 40,
      status: 'completed',
      versionTuple: { workflowVersion: '2.0.0' },
    });
    expect(timeline[1]?.inputSummary).toContain('"cardNumber":"[REDACTED]"');
    expect(timeline[1]?.outputSummary).toContain('"cardNumber":"[REDACTED]"');
  });

  it('acceptance criterion: engine.replayTo(workflowId, step) reconstructs checkpoint state, accumulated results, and event log up to that step', async () => {
    let now = 10_000;
    const storage = new MemoryStorage();

    async function firstStep() {
      now += 5;
      return { apiKey: 'sk-test-123', phase: 'first' as const };
    }

    async function secondStep() {
      now += 10;
      return { phase: 'second' as const };
    }

    async function thirdStep() {
      now += 15;
      return { phase: 'third' as const };
    }

    engine = new Engine({ storage, checkpointHistory: 10, getNow: () => now });
    const threeStepsWorkflow = workflow({ name: 'three-steps', version: '3.1.0' }).execute(
      async function* (ctx: WorkflowContext) {
        yield* ctx.run(firstStep);
        yield* ctx.run(secondStep);
        return yield* ctx.run(thirdStep);
      },
    );
    engine.register(threeStepsWorkflow);

    const handle = await engine.start('three-steps', null, { id: 'wf-replay' });
    await handle.result();

    const timelineBeforeReplay = await engine.getTimeline('wf-replay');
    const checkpointsBeforeReplay = await engine.listCheckpoints('wf-replay');

    const replay = await engine.replayTo('wf-replay', 2);
    const timelineAfterReplay = await engine.getTimeline('wf-replay');
    const checkpointsAfterReplay = await engine.listCheckpoints('wf-replay');

    expect(replay).not.toBeNull();
    expect(replay?.checkpoint).toMatchObject({
      step: 2,
      version: '3.1.0',
    });
    expect(timelineBeforeReplay).toHaveLength(3);
    expect(timelineAfterReplay).toEqual(timelineBeforeReplay);
    expect(checkpointsAfterReplay).toEqual(checkpointsBeforeReplay);
    expect(replay?.accumulatedResults).toEqual([[0, { apiKey: '[REDACTED]', phase: 'first' }]]);
    expect(replay?.accumulatedResults).toHaveLength(1);
    expect(replay?.events.map((event) => event.type)).toEqual([
      'workflow:checkpoint',
      'workflow:checkpoint',
    ]);
    expect(replay?.events).toHaveLength(2);
  });

  it('ignores malformed stored timeline entries and returns results sorted by step', async () => {
    const storage = new MemoryStorage();
    engine = new Engine({ storage, checkpointHistory: 10 });
    const noopWorkflow = workflow({ name: 'noop' }).execute(async function* () {
      return null;
    });
    engine.register(noopWorkflow);

    await storage.put(
      KEYS.timeline('wf-malformed-timeline', 2),
      encode({
        step: 2,
        operationType: 'activity',
        operationLabel: 'second',
        inputSummary: '{}',
        timestamp: 2_000,
        status: 'completed',
      }),
    );
    await storage.put(
      KEYS.timeline('wf-malformed-timeline', 1),
      encode({
        step: 1,
        operationType: 'activity',
        operationLabel: 'first',
        inputSummary: '{}',
        timestamp: 1_000,
        status: 'running',
      }),
    );
    await storage.put(
      KEYS.timeline('wf-malformed-timeline', 3),
      encode({
        step: 3,
        operationType: 'activity',
        operationLabel: 'broken',
        inputSummary: '{}',
        timestamp: 3_000,
        status: 'not-a-real-status',
      }),
    );
    await storage.put(
      KEYS.timeline('wf-malformed-timeline', 4),
      encode({
        step: 0,
        operationType: 'activity',
        operationLabel: 'zero-step',
        inputSummary: '{}',
        timestamp: 4_000,
        status: 'completed',
      }),
    );
    await storage.put(
      KEYS.timeline('wf-malformed-timeline', 5),
      encode({
        step: Number.NaN,
        operationType: 'activity',
        operationLabel: 'nan-step',
        inputSummary: '{}',
        timestamp: 5_000,
        status: 'completed',
      }),
    );
    await storage.put(
      KEYS.timeline('wf-malformed-timeline', 6),
      encode({
        step: 6,
        operationType: 'activity',
        operationLabel: 'infinite-timestamp',
        inputSummary: '{}',
        timestamp: Number.POSITIVE_INFINITY,
        status: 'completed',
      }),
    );
    await storage.put(
      KEYS.timeline('wf-malformed-timeline', 7),
      encode({
        step: 7,
        operationType: 'activity',
        operationLabel: 'nan-duration',
        inputSummary: '{}',
        timestamp: 7_000,
        status: 'completed',
        duration: Number.NaN,
      }),
    );
    await storage.put(KEYS.timeline('wf-malformed-timeline', 8), new Uint8Array([0xc1]));

    const timeline = await engine.getTimeline('wf-malformed-timeline');

    expect(timeline.map((entry) => entry.step)).toEqual([1, 2]);
  });

  it('keeps malformed timeline summary strings unchanged instead of re-quoting them', async () => {
    const storage = new MemoryStorage();
    engine = new Engine({ storage, checkpointHistory: 10 });

    await storage.put(
      KEYS.timeline('wf-summary-fallback', 1),
      encode({
        step: 1,
        operationType: 'activity',
        operationLabel: 'summaries',
        inputSummary: 'undefined',
        outputSummary: '[unserializable]',
        timestamp: 1_000,
        status: 'failed',
      }),
    );

    const timeline = await engine.getTimeline('wf-summary-fallback');

    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.inputSummary).toBe('undefined');
    expect(timeline[0]?.outputSummary).toBe('[unserializable]');
  });

  it('does not overwrite a failed operation timeline duration during workflow failure cleanup', async () => {
    let now = 0;
    const storage = new MemoryStorage();
    engine = new Engine({ storage, checkpointHistory: 10, getNow: () => now++ });

    async function failStep() {
      throw new Error('timeline failure');
    }

    const timelineFailureWorkflow = workflow({ name: 'timeline-failure' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.run(failStep);
    });
    engine.register(timelineFailureWorkflow);

    const handle = await engine.start('timeline-failure', null, { id: 'wf-timeline-failure' });
    await handle.result().catch(() => {});

    const timeline = await engine.getTimeline('wf-timeline-failure');

    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      status: 'failed',
      operationLabel: 'failStep',
    });
    expect(timeline[0]?.duration).toBe(1);
    expect(timeline[0]?.outputSummary).toContain('timeline failure');
  });
});
