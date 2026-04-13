import { describe, expect, it } from 'bun:test';

import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { encode } from './codec.ts';
import { Context } from './context.ts';
import { Engine } from './engine.ts';
import { getNextCronOccurrence } from './schedule.ts';
import { tenantFromInputField, type TenantResolver } from './tenant.ts';
import type { ScheduleSummary, WorkflowContext, WorkflowFunction } from './types.ts';

type Clock = {
  now: number;
};

function createEngine(
  clock: Clock,
  storage = new MemoryStorage(),
  tenantResolver?: TenantResolver,
) {
  return new Engine({
    storage,
    getNow: () => clock.now,
    ...(tenantResolver !== undefined && { tenantResolver }),
  });
}

async function drainEngine(): Promise<void> {
  await Bun.sleep(0);
  await Bun.sleep(0);
}

function registerWorkflow<TInput, TOutput>(
  engine: Engine,
  name: string,
  handler: WorkflowFunction<TInput, TOutput>,
): void {
  engine.register(name, handler as WorkflowFunction);
}

function requireNextFireAt(summary: ScheduleSummary): number {
  if (summary.nextFireAt === null) {
    throw new Error(`Schedule "${summary.id}" does not have a next fire time`);
  }
  return summary.nextFireAt;
}

async function tickEngine(engine: Engine, clock: Clock, nextNow: number): Promise<void> {
  clock.now = nextNow;
  await engine.scheduler.tick(clock.now);
  await drainEngine();
}

async function listRunningWorkflowIds(engine: Engine): Promise<string[]> {
  const result = await engine.list({ status: 'running' });
  return result.items.map((item) => item.id).toSorted();
}

async function releaseRunningWorkflows(engine: Engine): Promise<void> {
  for (const workflowId of await listRunningWorkflowIds(engine)) {
    await engine.signal(workflowId, 'release');
  }
  await drainEngine();
}

describe('recurring schedules', () => {
  it('engine.schedule(type, input, cronExpression, options?) registers a recurring workflow and fires it at the next cron boundary', async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock);
    const executions: Array<{ value: string }> = [];

    registerWorkflow(
      engine,
      'scheduled-echo',
      async function* (_ctx: WorkflowContext, input: { value: string }) {
        executions.push(input);
        return input.value;
      },
    );

    const schedule = await engine.schedule('scheduled-echo', { value: 'first-run' }, '* * * * *');
    const description = await schedule.describe();

    expect(description).toMatchObject({
      workflowType: 'scheduled-echo',
      cronExpression: '* * * * *',
      overlap: 'skip',
      backfill: false,
      status: 'active',
    });
    expect(description.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 1, 0));

    await tickEngine(engine, clock, requireNextFireAt(description));

    expect(executions).toEqual([{ value: 'first-run' }]);

    engine[Symbol.dispose]();
  });

  it('Schedules are durable. Stored in storage under schedule:{id}. Survive process restarts. The scheduler scans for due schedules on startup and resumes ticking.', async () => {
    const storage = new MemoryStorage();
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const executions: string[] = [];

    const firstEngine = createEngine(clock, storage);
    registerWorkflow(
      firstEngine,
      'durable-scheduled-echo',
      async function* (_ctx: WorkflowContext, input: string) {
        executions.push(input);
        return input;
      },
    );

    const schedule = await firstEngine.schedule(
      'durable-scheduled-echo',
      'recovered-run',
      '*/15 * * * * *',
      { id: 'nightly-maintenance' },
    );
    const firstDescription = await schedule.describe();

    expect(await storage.get(KEYS.schedule('nightly-maintenance'))).not.toBeNull();

    firstEngine[Symbol.dispose]();

    const secondEngine = createEngine(clock, storage);
    registerWorkflow(
      secondEngine,
      'durable-scheduled-echo',
      async function* (_ctx: WorkflowContext, input: string) {
        executions.push(input);
        return input;
      },
    );
    await tickEngine(secondEngine, clock, requireNextFireAt(firstDescription));

    expect(executions).toEqual(['recovered-run']);

    secondEngine[Symbol.dispose]();
  });

  it("Overlap policy is configurable. { overlap: 'skip' } does not start a new run while the previous run is still executing.", async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock);

    registerWorkflow(engine, 'overlap-skip', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('release');
      return 'released';
    });

    const schedule = await engine.schedule('overlap-skip', null, '* * * * *', { overlap: 'skip' });
    const firstDescription = await schedule.describe();

    await tickEngine(engine, clock, requireNextFireAt(firstDescription));
    expect(await listRunningWorkflowIds(engine)).toHaveLength(1);

    const secondDescription = await schedule.describe();
    await tickEngine(engine, clock, requireNextFireAt(secondDescription));

    expect(await listRunningWorkflowIds(engine)).toHaveLength(1);

    await releaseRunningWorkflows(engine);
    engine[Symbol.dispose]();
  });

  it("Overlap policy is configurable. { overlap: 'allow' } starts a new run even while the previous run is still executing.", async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock);

    registerWorkflow(engine, 'overlap-allow', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('release');
      return 'released';
    });

    const schedule = await engine.schedule('overlap-allow', null, '* * * * *', {
      overlap: 'allow',
    });
    const firstDescription = await schedule.describe();

    await tickEngine(engine, clock, requireNextFireAt(firstDescription));
    expect(await listRunningWorkflowIds(engine)).toHaveLength(1);

    const secondDescription = await schedule.describe();
    await tickEngine(engine, clock, requireNextFireAt(secondDescription));

    expect(await listRunningWorkflowIds(engine)).toHaveLength(2);

    await releaseRunningWorkflows(engine);
    engine[Symbol.dispose]();
  });

  it("Overlap policy is configurable. { overlap: 'cancel-running' } cancels the previous run before starting a new one.", async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock);

    registerWorkflow(engine, 'overlap-cancel-running', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('release');
      return 'released';
    });

    const schedule = await engine.schedule('overlap-cancel-running', null, '* * * * *', {
      overlap: 'cancel-running',
    });
    const firstDescription = await schedule.describe();

    await tickEngine(engine, clock, requireNextFireAt(firstDescription));
    const [firstWorkflowId] = await listRunningWorkflowIds(engine);
    expect(firstWorkflowId).toBeDefined();

    const secondDescription = await schedule.describe();
    await tickEngine(engine, clock, requireNextFireAt(secondDescription));

    expect(await engine.get(firstWorkflowId!)).toMatchObject({ status: 'cancelled' });
    expect(await listRunningWorkflowIds(engine)).toHaveLength(1);

    await releaseRunningWorkflows(engine);
    engine[Symbol.dispose]();
  });

  it("Overlap policy is configurable. { overlap: 'queue' } waits for the previous run to complete before starting the queued run.", async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock);

    registerWorkflow(engine, 'overlap-queue', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('release');
      return 'released';
    });

    const schedule = await engine.schedule('overlap-queue', null, '* * * * *', {
      overlap: 'queue',
    });
    const firstDescription = await schedule.describe();

    await tickEngine(engine, clock, requireNextFireAt(firstDescription));
    const [firstWorkflowId] = await listRunningWorkflowIds(engine);
    expect(firstWorkflowId).toBeDefined();

    const secondDescription = await schedule.describe();
    await tickEngine(engine, clock, requireNextFireAt(secondDescription));
    expect(await listRunningWorkflowIds(engine)).toHaveLength(1);

    await engine.signal(firstWorkflowId!, 'release');
    await drainEngine();

    const runningAfterRelease = await listRunningWorkflowIds(engine);
    expect(runningAfterRelease).toHaveLength(1);
    expect(runningAfterRelease[0]).not.toBe(firstWorkflowId);

    await releaseRunningWorkflows(engine);
    engine[Symbol.dispose]();
  });

  it('Schedules support backfill. { backfill: true } runs missed ticks on recovery and { backfill: false } skips them.', async () => {
    const storage = new MemoryStorage();
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const executions: Array<string> = [];

    const firstEngine = createEngine(clock, storage);
    registerWorkflow(
      firstEngine,
      'backfill-workflow',
      async function* (_ctx: WorkflowContext, input: string) {
        executions.push(input);
        return input;
      },
    );

    const catchUp = await firstEngine.schedule('backfill-workflow', 'catch-up', '* * * * *', {
      id: 'schedule-catch-up',
      backfill: true,
    });
    const skip = await firstEngine.schedule('backfill-workflow', 'skip-missed', '* * * * *', {
      id: 'schedule-skip',
      backfill: false,
    });
    const catchUpDescription = await catchUp.describe();
    const skipDescription = await skip.describe();

    firstEngine[Symbol.dispose]();

    const secondEngine = createEngine(clock, storage);
    registerWorkflow(
      secondEngine,
      'backfill-workflow',
      async function* (_ctx: WorkflowContext, input: string) {
        executions.push(input);
        return input;
      },
    );

    await tickEngine(secondEngine, clock, Date.UTC(2026, 0, 1, 0, 3, 0));

    expect(executions.filter((input) => input === 'catch-up')).toHaveLength(3);
    expect(executions.filter((input) => input === 'skip-missed')).toHaveLength(0);

    const updatedCatchUp = await secondEngine.getSchedule(catchUpDescription.id);
    const updatedSkip = await secondEngine.getSchedule(skipDescription.id);
    expect(updatedCatchUp?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 4, 0));
    expect(updatedSkip?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 4, 0));

    secondEngine[Symbol.dispose]();
  });

  it('Caps backfill catch-up work per scheduler tick when many cron occurrences were missed.', async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock);
    const executions: number[] = [];

    registerWorkflow(engine, 'bounded-backfill-workflow', async function* (_ctx: WorkflowContext) {
      executions.push(clock.now);
      return clock.now;
    });

    const schedule = await engine.schedule('bounded-backfill-workflow', null, '* * * * * *', {
      backfill: true,
    });

    await tickEngine(engine, clock, Date.UTC(2026, 0, 1, 0, 5, 0));

    const firstPassExecutionCount = executions.length;
    expect(firstPassExecutionCount).toBeGreaterThan(0);
    expect(firstPassExecutionCount).toBeLessThan(300);

    const afterFirstPass = await schedule.describe();
    expect(requireNextFireAt(afterFirstPass)).toBeLessThanOrEqual(clock.now);

    await engine.scheduler.tick(clock.now);
    await drainEngine();

    expect(executions.length).toBeGreaterThan(firstPassExecutionCount);

    engine[Symbol.dispose]();
  });

  it('Schedules are listable and queryable. engine.listSchedules(filter?) returns next fire time, last fire time, and status.', async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock);

    registerWorkflow(engine, 'listable-schedule-workflow', async function* () {
      return 'done';
    });

    const activeSchedule = await engine.schedule('listable-schedule-workflow', null, '* * * * *', {
      id: 'active-schedule',
    });
    const pausedSchedule = await engine.schedule(
      'listable-schedule-workflow',
      null,
      '*/15 * * * * *',
      {
        id: 'paused-schedule',
      },
    );

    await pausedSchedule.pause();
    await pausedSchedule.update('*/30 * * * * *');
    await pausedSchedule.resume();
    await pausedSchedule.pause();

    const activeDescription = await activeSchedule.describe();
    await tickEngine(engine, clock, requireNextFireAt(activeDescription));

    const allSchedules = await engine.listSchedules();
    const pausedSchedules = await engine.listSchedules({ status: 'paused' });

    expect(allSchedules.items.map((item) => item.id).toSorted()).toEqual([
      'active-schedule',
      'paused-schedule',
    ]);
    expect(allSchedules.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'active-schedule',
          status: 'active',
          lastFireAt: activeDescription.nextFireAt,
        }),
        expect.objectContaining({
          id: 'paused-schedule',
          status: 'paused',
          cronExpression: '*/30 * * * * *',
        }),
      ]),
    );
    expect(pausedSchedules.items).toEqual([
      expect.objectContaining({
        id: 'paused-schedule',
        status: 'paused',
      }),
    ]);

    await pausedSchedule.cancel();
    expect(await engine.getSchedule('paused-schedule')).toMatchObject({ status: 'cancelled' });

    engine[Symbol.dispose]();
  });

  it('Schedule summaries omit stored workflow input from describe, getSchedule, and listSchedules.', async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock);

    registerWorkflow(engine, 'summary-redaction-workflow', async function* () {
      return 'done';
    });

    const schedule = await engine.schedule(
      'summary-redaction-workflow',
      { secret: 'top-secret' },
      '* * * * *',
      { id: 'redacted-summary' },
    );

    const describedSchedule = await schedule.describe();
    const loadedSchedule = await engine.getSchedule('redacted-summary');
    const listedSchedules = await engine.listSchedules();
    const listedSchedule = listedSchedules.items.find(
      (summary) => summary.id === 'redacted-summary',
    );

    expect(loadedSchedule).not.toBeNull();
    expect(listedSchedule).toBeDefined();

    for (const summary of [describedSchedule, loadedSchedule, listedSchedule]) {
      expect(summary).toBeDefined();
      expect(Object.keys(summary as ScheduleSummary).includes('input')).toBe(false);
    }

    engine[Symbol.dispose]();
  });

  it('Rejects malformed persisted schedules and validates runtime schedule inputs.', async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const storage = new MemoryStorage();
    const engine = createEngine(clock, storage);

    registerWorkflow(engine, 'validated-schedule-workflow', async function* () {
      return 'done';
    });

    await storage.put(
      KEYS.schedule('corrupt-schedule'),
      encode({
        id: 'corrupt-schedule',
        workflowType: 'validated-schedule-workflow',
        cronExpression: 42,
      }),
    );

    expect(await engine.getSchedule('corrupt-schedule')).toBeNull();
    const listedSchedules = await engine.listSchedules();
    expect(listedSchedules.items).toEqual([]);
    await expect(
      engine.schedule('validated-schedule-workflow', null, '* * * * *', {
        overlap: 'bogus' as unknown as never,
      }),
    ).rejects.toThrow('options.overlap');
    await expect(engine.getSchedule('')).rejects.toThrow('scheduleId');

    engine[Symbol.dispose]();
  });

  it('Tests cover: cron edge cases (Feb 29) by scheduling the next leap-day fire time correctly.', () => {
    const nextFireAt = getNextCronOccurrence('0 0 29 2 *', Date.UTC(2025, 1, 28, 0, 0, 0), {
      timeZone: 'UTC',
    });

    expect(nextFireAt).toBe(Date.UTC(2028, 1, 29, 0, 0, 0));
  });

  it('Tests cover: cron edge cases (DST transitions) by skipping nonexistent spring-forward wall-clock times.', () => {
    const nextFireAt = getNextCronOccurrence(
      '0 30 2 * * *',
      Date.parse('2026-03-08T06:00:00.000Z'),
      { timeZone: 'America/New_York' },
    );

    expect(nextFireAt).toBe(Date.parse('2026-03-09T06:30:00.000Z'));
  });

  it('Tests cover: cron edge cases (DST transitions) by emitting both repeated fall-back wall-clock times.', () => {
    const nextFireAt = getNextCronOccurrence(
      '0 30 1 * * *',
      Date.parse('2026-11-01T05:30:00.000Z'),
      { timeZone: 'America/New_York' },
    );

    expect(nextFireAt).toBe(Date.parse('2026-11-01T06:30:00.000Z'));
  });

  it('Tests cover: multi-tenant schedule isolation.', async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const storage = new MemoryStorage();
    const engine = createEngine(clock, storage, tenantFromInputField('tenantId'));
    const observedTenants: string[] = [];

    registerWorkflow(
      engine,
      'tenant-aware-schedule',
      async function* (ctx: WorkflowContext, input: { tenantId: string }) {
        observedTenants.push(`${ctx.tenant?.id}:${input.tenantId}`);
        return ctx.tenant?.id ?? 'missing';
      },
    );

    const alphaSchedule = await engine.schedule(
      'tenant-aware-schedule',
      { tenantId: 'alpha' },
      '* * * * *',
      { id: 'tenant-alpha' },
    );
    const betaSchedule = await engine.schedule(
      'tenant-aware-schedule',
      { tenantId: 'beta' },
      '* * * * *',
      { id: 'tenant-beta' },
    );
    expect(await engine.getSchedule('tenant-alpha')).toBeNull();
    expect(await engine.getSchedule('tenant-alpha', { tenantId: 'alpha' })).toMatchObject({
      id: 'tenant-alpha',
    });
    const unscopedSchedules = await engine.listSchedules();
    const alphaSchedules = await engine.listSchedules({ tenantId: 'alpha' });
    expect(unscopedSchedules.items).toEqual([]);
    expect(alphaSchedules.items).toEqual([expect.objectContaining({ id: 'tenant-alpha' })]);

    const descriptions: ScheduleSummary[] = [
      await alphaSchedule.describe(),
      await betaSchedule.describe(),
    ];

    engine[Symbol.dispose]();

    const recoveredEngine = createEngine(clock, storage);
    registerWorkflow(
      recoveredEngine,
      'tenant-aware-schedule',
      async function* (ctx: WorkflowContext, input: { tenantId: string }) {
        observedTenants.push(`${ctx.tenant?.id}:${input.tenantId}`);
        return ctx.tenant?.id ?? 'missing';
      },
    );

    await tickEngine(
      recoveredEngine,
      clock,
      Math.max(...descriptions.map((description) => requireNextFireAt(description))),
    );

    expect(observedTenants.toSorted()).toEqual(['alpha:alpha', 'beta:beta']);

    recoveredEngine[Symbol.dispose]();
  });
});
