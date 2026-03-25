# Testing

Durable workflows are inherently hard to test. They span time---sleeps, retries, timeouts---and depend on external services. You don't want your test suite waiting 30 real seconds for a timer to fire or hitting a real payment API. Weft's testing module gives you deterministic time control, activity mocking, and crash-recovery simulation.

## TestEngine

`TestEngine` is a subclass of `Engine` backed by in-memory storage and a virtual clock. Everything behaves like the real engine, but you control time and can mock activities.

```typescript
import { TestEngine } from 'weft/testing';

const engine = new TestEngine();

engine.register('order', orderWorkflow);

const handle = await engine.start('order', { items: ['widget'], total: 99 });
```

The constructor accepts an optional `startTime` (milliseconds since epoch) for the virtual clock. If omitted, it uses the real `Date.now()` at construction time.

```typescript
const engine = new TestEngine({ startTime: 1700000000000 });
```

## Advancing time

The killer feature. `advanceTime()` moves the virtual clock forward, firing any timers---both `TimeControl` timers and the engine's durable scheduler timers---that fall within the window.

```typescript
// Workflow sleeps for 1 hour
engine.register('delayed', async function* (ctx) {
  yield* ctx.sleep('1 hour');
  return 'done';
});

const handle = await engine.start('delayed', null);

// Jump forward---no real waiting
await engine.advanceTime('1 hour');

const result = await handle.result();
expect(result).toBe('done');
```

`advanceTime()` accepts any `Duration`---a number in milliseconds or a string like `'5m'`, `'2 hours'`, `'30s'`. After advancing, it ticks the scheduler and allows microtasks to settle.

Check the current virtual time with `engine.now`:

```typescript
console.log(engine.now); // milliseconds since epoch
```

## TimeControl

Under the hood, `TestEngine` uses a `TimeControl` instance. You can also use it directly if you need finer control.

```typescript
import { TimeControl } from 'weft/testing';

const clock = new TimeControl(1700000000000);
console.log(clock.now); // 1700000000000

await clock.advance('10 minutes');
console.log(clock.now); // 1700000600000

await clock.advanceTo(1700001000000);
console.log(clock.now); // 1700001000000
```

`TimeControl` doesn't monkey-patch global timers. It provides an explicit `now` property and a `schedule()` method for registering callbacks that fire when virtual time passes their target.

```typescript
const cancel = clock.schedule(clock.now + 5000, () => {
  console.log('Fired at', clock.now);
});

await clock.advance(5000); // "Fired at 1700000005000"
```

Useful properties for assertions:

- `clock.pendingTimerCount` --- how many timers haven't fired yet
- `clock.nextTimerAt` --- the fire time of the earliest pending timer
- `clock.reset(startTime?)` --- reset to initial state

## Mocking activities

`TestEngine.mock()` registers a fake implementation for an activity function. When the engine encounters that activity during workflow execution, it calls your mock instead.

```typescript
async function charge(order: Order): Promise<PaymentResult> {
  // Real implementation hits Stripe
}

const mockCharge = engine.mock(charge, (order) => ({
  id: 'pay_test_123',
  amount: order.total,
  status: 'succeeded',
}));
```

The mock is type-safe---the implementation must match the original function's signature.

## MockHandle

`mock()` returns a `MockHandle` with call recording and override capabilities:

```typescript
interface MockHandle<TArgs, TResult> {
  readonly calls: ReadonlyArray<MockCall<TArgs, TResult>>;
  readonly callCount: number;
  readonly lastCall: MockCall<TArgs, TResult> | undefined;
  mockImplementation(impl: (...args: TArgs) => TResult | Promise<TResult>): void;
  mockReturnValueOnce(value: TResult): MockHandle<TArgs, TResult>;
  mockRejectionOnce(error: Error): MockHandle<TArgs, TResult>;
  resetCalls(): void;
  restore(): void;
}
```

Each recorded call captures args, result (or error), and timestamp:

```typescript
interface MockCall<TArgs, TResult> {
  readonly args: TArgs;
  readonly result: TResult | undefined;
  readonly error: Error | undefined;
  readonly timestamp: number;
}
```

Use it in assertions:

```typescript
expect(mockCharge.callCount).toBe(1);
expect(mockCharge.lastCall?.args).toEqual([{ items: ['widget'], total: 99 }]);
expect(mockCharge.lastCall?.result).toEqual({
  id: 'pay_test_123',
  amount: 99,
  status: 'succeeded',
});
```

## One-shot overrides

Chain `.mockReturnValueOnce()` and `.mockRejectionOnce()` for per-call behavior. These are consumed in order---after they're exhausted, the base implementation runs.

```typescript
const mockShip = engine.mock(ship, () => ({ tracking: 'TRACK-001' }));

// First call fails, second succeeds
mockShip
  .mockRejectionOnce(new Error('Carrier unavailable'))
  .mockReturnValueOnce({ tracking: 'TRACK-RETRY' });
```

This is perfect for testing retry logic. The first attempt fails, the engine retries, and the second attempt succeeds with the one-shot value.

## Crash recovery simulation

`TestEngine.recover()` creates a new engine backed by a copy of the current engine's storage, simulating a process restart. The new engine sees all persisted state but has fresh in-memory structures.

```typescript
engine.register('resilient', async function* (ctx) {
  const step1 = yield* ctx.run(doFirstThing);

  // Simulate crash here
  // step1 is checkpointed, so recovery picks up after it

  const step2 = yield* ctx.run(doSecondThing, step1);
  return step2;
});

const handle = await engine.start('resilient', null);
// Wait for step1 to complete and checkpoint
await Bun.sleep(10);

// Simulate crash and recovery
const recovered = engine.recover();
recovered.register('resilient', resilientWorkflow);

// The workflow resumes from the checkpoint---step1 doesn't re-execute
```

The recovered engine has its own `TimeControl` initialized to the current engine's virtual time.

## Test patterns with Bun's test runner

Here's a complete test combining everything:

```typescript
import { describe, expect, it } from 'bun:test';
import { TestEngine } from 'weft/testing';

describe('order workflow', () => {
  it('processes an order end to end', async () => {
    const engine = new TestEngine();

    const mockCharge = engine.mock(charge, (order) => ({
      id: 'pay_123',
      amount: order.total,
    }));

    const mockShip = engine.mock(ship, () => ({
      tracking: 'TRACK-001',
    }));

    engine.register('order', orderWorkflow);

    const handle = await engine.start('order', {
      items: ['widget'],
      total: 42,
    });

    const result = await handle.result();

    expect(result.payment.id).toBe('pay_123');
    expect(result.shipment.tracking).toBe('TRACK-001');
    expect(mockCharge.callCount).toBe(1);
    expect(mockShip.callCount).toBe(1);
  });

  it('handles payment failure gracefully', async () => {
    const engine = new TestEngine();

    engine.mock(charge, () => {
      throw new Error('Card declined');
    });

    engine.register('order', orderWorkflow);
    const handle = await engine.start('order', { total: 100 });

    await expect(handle.result()).rejects.toThrow('Card declined');
  });
});
```

Direct storage access via `engine.storage` (a `MemoryStorage` instance) lets you inspect persisted state in assertions when you need to verify checkpoint contents or attribute values. The mock registry is also accessible at `engine.mocks` if you need to manage mocks programmatically.
