import { afterEach, describe, expect, it } from 'bun:test';

import { ActivityMockRegistry } from './mocks';

async function sendEmail(to: string, body: string): Promise<string> {
  return `sent to ${to}: ${body}`;
}

async function processPayment(amount: number): Promise<{ id: string }> {
  return { id: `pay-${amount}` };
}

describe('ActivityMockRegistry', () => {
  let registry: ActivityMockRegistry;

  afterEach(() => {
    registry?.restoreAll();
  });

  it('registers a mock so has() returns true', () => {
    registry = new ActivityMockRegistry();
    registry.mock(sendEmail, async () => 'mocked');
    expect(registry.has(sendEmail)).toBe(true);
  });

  it('calls the mock implementation when executed', async () => {
    registry = new ActivityMockRegistry();
    const handle = registry.mock(sendEmail, async (_to, _body) => 'fake-result');

    const mocked = registry.get(sendEmail);
    const result = await mocked!.implementation('alice@test.com', 'hello');
    expect(result).toBe('fake-result');
    expect(handle.callCount).toBe(1);
  });

  it('records all invocations with args', async () => {
    registry = new ActivityMockRegistry();
    const handle = registry.mock(sendEmail, async () => 'ok');

    const mocked = registry.get(sendEmail)!;
    await mocked.implementation('a@test.com', 'first');
    await mocked.implementation('b@test.com', 'second');

    expect(handle.calls).toHaveLength(2);
    expect(handle.calls[0]!.args).toEqual(['a@test.com', 'first']);
    expect(handle.calls[1]!.args).toEqual(['b@test.com', 'second']);
  });

  it('records results in call history', async () => {
    registry = new ActivityMockRegistry();
    const handle = registry.mock(sendEmail, async () => 'result-value');

    const mocked = registry.get(sendEmail)!;
    await mocked.implementation('a@test.com', 'hi');

    expect(handle.calls[0]!.result).toBe('result-value');
    expect(handle.calls[0]!.error).toBeUndefined();
  });

  it('returns the correct callCount', async () => {
    registry = new ActivityMockRegistry();
    const handle = registry.mock(sendEmail, async () => 'ok');

    const mocked = registry.get(sendEmail)!;
    await mocked.implementation('a', 'b');
    await mocked.implementation('c', 'd');
    await mocked.implementation('e', 'f');

    expect(handle.callCount).toBe(3);
  });

  it('returns the most recent call via lastCall', async () => {
    registry = new ActivityMockRegistry();
    const handle = registry.mock(sendEmail, async () => 'ok');

    expect(handle.lastCall).toBeUndefined();

    const mocked = registry.get(sendEmail)!;
    await mocked.implementation('first@test.com', 'a');
    await mocked.implementation('last@test.com', 'b');

    expect(handle.lastCall!.args).toEqual(['last@test.com', 'b']);
  });

  it('replaces the implementation via mockImplementation', async () => {
    registry = new ActivityMockRegistry();
    const handle = registry.mock(sendEmail, async () => 'original');

    const mocked = registry.get(sendEmail)!;
    const firstResult = await mocked.implementation('a', 'b');
    expect(firstResult).toBe('original');

    handle.mockImplementation(async () => 'replaced');
    const secondResult = await mocked.implementation('a', 'b');
    expect(secondResult).toBe('replaced');
  });

  it('returns a value once with mockReturnValueOnce then falls back', async () => {
    registry = new ActivityMockRegistry();
    const handle = registry.mock(sendEmail, async () => 'default');

    handle.mockReturnValueOnce('once-value');

    const mocked = registry.get(sendEmail)!;
    const first = await mocked.implementation('a', 'b');
    const second = await mocked.implementation('a', 'b');

    expect(first).toBe('once-value');
    expect(second).toBe('default');
  });

  it('rejects once with mockRejectionOnce then succeeds', async () => {
    registry = new ActivityMockRegistry();
    const handle = registry.mock(sendEmail, async () => 'default');

    handle.mockRejectionOnce(new Error('boom'));

    const mocked = registry.get(sendEmail)!;

    let thrownError: Error | undefined;
    try {
      await (mocked.implementation('a', 'b') as Promise<unknown>);
    } catch (error) {
      thrownError = error as Error;
    }
    expect(thrownError).toBeDefined();
    expect(thrownError!.message).toBe('boom');

    const second = await mocked.implementation('a', 'b');
    expect(second).toBe('default');
  });

  it('clears call history with resetCalls', async () => {
    registry = new ActivityMockRegistry();
    const handle = registry.mock(sendEmail, async () => 'ok');

    const mocked = registry.get(sendEmail)!;
    await mocked.implementation('a', 'b');
    expect(handle.callCount).toBe(1);

    handle.resetCalls();
    expect(handle.callCount).toBe(0);
    expect(handle.calls).toHaveLength(0);
    expect(handle.lastCall).toBeUndefined();
  });

  it('removes a mock with restore so has() returns false', async () => {
    registry = new ActivityMockRegistry();
    const handle = registry.mock(sendEmail, async () => 'ok');

    expect(registry.has(sendEmail)).toBe(true);
    handle.restore();
    expect(registry.has(sendEmail)).toBe(false);
  });

  it('removes all mocks with restoreAll', () => {
    registry = new ActivityMockRegistry();
    registry.mock(sendEmail, async () => 'ok');
    registry.mock(processPayment, async () => ({ id: 'mock' }));

    expect(registry.has(sendEmail)).toBe(true);
    expect(registry.has(processPayment)).toBe(true);

    registry.restoreAll();

    expect(registry.has(sendEmail)).toBe(false);
    expect(registry.has(processPayment)).toBe(false);
  });

  it('works with async mock implementations', async () => {
    registry = new ActivityMockRegistry();
    const handle = registry.mock(processPayment, async (amount) => {
      await Promise.resolve();
      return { id: `mock-${amount}` };
    });

    const mocked = registry.get(processPayment)!;
    const result = await mocked.implementation(500);

    expect(result).toEqual({ id: 'mock-500' });
    expect(handle.callCount).toBe(1);
    expect(handle.calls[0]!.result).toEqual({ id: 'mock-500' });
  });
});
