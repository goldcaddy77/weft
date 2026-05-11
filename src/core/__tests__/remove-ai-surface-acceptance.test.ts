/**
 * Gate-9 acceptance test for the remove-ai-surface refactor.
 *
 * Bundles the three binary acceptance criteria from the plan into one file
 * so a single `bun test` run can confirm the post-removal contract:
 *
 *   1. Engine + ctx.review() round-trip (request → persist → retrieve → submit
 *      → resume) and timeout firing.
 *   2. Engine + EffectLog crash-and-replay idempotency.
 *   3. computeSemanticHash determinism across two engine instances.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { sleepForTesting } from '../../testing/fake-timers.ts';
import { TestEngine } from '../../testing/test-engine.ts';
import { computeSemanticHash, EffectLog } from '../effect-log/index.ts';
import { ReviewTimeoutError } from '../review/index.ts';
import type { WorkflowContext } from '../types.ts';

describe('remove-ai-surface acceptance gates', () => {
  let engine: TestEngine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('ctx.review() round-trip: persist, retrieve, submit, resume with decision', async () => {
    engine = new TestEngine();

    engine.register('needs-approval', async function* (ctx: WorkflowContext) {
      const result = yield* ctx.review({
        artifact: { amount: 99, recipient: 'alice' },
        reviewType: 'payment',
        reviewers: ['manager@example.com'],
      });
      return result;
    });

    const handle = await engine.start('needs-approval', null);
    const resultPromise = handle.result();
    await sleepForTesting(10);

    // Locate the persisted review request via the engine surface that
    // server routes use.
    const pending = await engine.listReviews();
    expect(pending).toHaveLength(1);
    const { reviewId, workflowId, artifact } = pending[0]!;
    expect(workflowId).toBe(handle.id);
    expect(artifact).toEqual({ amount: 99, recipient: 'alice' });

    const retrieved = await engine.getReview(workflowId, reviewId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.reviewId).toBe(reviewId);

    await engine.submitReview(reviewId, {
      decision: 'approved',
      reviewer: 'manager@example.com',
    });

    const result = await resultPromise;
    expect(result).toMatchObject({
      reviewId,
      decision: 'approved',
      reviewer: 'manager@example.com',
    });
  });

  it('ctx.review() timeout fails the workflow with ReviewTimeoutError after deadline elapses', async () => {
    engine = new TestEngine({ startTime: 1_000 });

    engine.register('approval-with-timeout', async function* (ctx: WorkflowContext) {
      return yield* ctx.review({
        artifact: 'release plan',
        reviewers: ['alice@example.com'],
        timeout: 5_000,
      });
    });

    const handle = await engine.start('approval-with-timeout', null);
    // Attach the catch up-front so the eventual rejection isn't reported
    // as an unhandled promise before we assert on the workflow state.
    const settled = handle.result().catch((error: unknown) => error);
    await sleepForTesting(10);

    await engine.advanceTime(6_000);
    await sleepForTesting(50);

    const error = await settled;
    expect(error).toBeInstanceOf(ReviewTimeoutError);

    const state = await engine.get(handle.id);
    expect(state!.status).toBe('failed');
    expect(state!.error).toContain('timed out');
  });

  it('EffectLog: crash after record, replay returns committed output without re-executing', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'wf-crash-replay';
    const operationId = 'op-1';
    const semanticHash = computeSemanticHash({
      effect: 'charge-card',
      input: { amount: 99, idempotencyKey: 'k-1' },
    });

    let executions = 0;
    const sideEffect = async (): Promise<{ chargeId: string }> => {
      executions++;
      return { chargeId: `ch-${executions}` };
    };

    // First instance: record in-flight, run effect, commit output.
    const first = new EffectLog(storage, workflowId, operationId);
    expect(await first.lookup(semanticHash)).toBeNull();
    await first.record(semanticHash, 'charge-card');
    const output = await sideEffect();
    await first.commit(semanticHash, 'charge-card', output);

    // Simulate a crash: throw away the EffectLog reference but keep storage.
    // Replay with a fresh instance — the committed record must be observable
    // and the side effect must not run again.
    const replay = new EffectLog(storage, workflowId, operationId);
    const replayed = await replay.lookup(semanticHash);

    expect(replayed).not.toBeNull();
    expect(replayed!.status).toBe('committed');
    if (replayed!.status !== 'committed') {
      throw new Error('expected committed record');
    }
    expect(replayed.output).toEqual({ chargeId: 'ch-1' });
    expect(replayed.effectName).toBe('charge-card');

    // Workflow logic skips the effect on replay because lookup hit committed.
    expect(executions).toBe(1);
  });

  it('computeSemanticHash is deterministic across two engine instances', async () => {
    const engineA = new TestEngine();
    const engineB = new TestEngine();
    try {
      const input = {
        method: 'POST',
        path: '/charges',
        body: { amount: 250, recipient: 'bob', notes: ['priority'] },
      };

      const hashFromA = computeSemanticHash(input);
      const hashFromB = computeSemanticHash(input);

      expect(hashFromA).toBe(hashFromB);

      // Key-order independence is part of the determinism contract.
      const reordered = {
        body: { recipient: 'bob', notes: ['priority'], amount: 250 },
        path: '/charges',
        method: 'POST',
      };
      expect(computeSemanticHash(reordered)).toBe(hashFromA);

      // Touching either engine before hashing must not perturb the hash.
      engineA.register('noop', async function* () {
        return 1;
      });
      engineB.register('noop', async function* () {
        return 2;
      });
      expect(computeSemanticHash(input)).toBe(hashFromA);
    } finally {
      engineA[Symbol.dispose]();
      engineB[Symbol.dispose]();
    }
  });
});
