import { describe, expect, it } from 'bun:test';

import { decode, encode } from '../core/codec.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { BudgetPolicyEnforcer, OrganizationBudgetExceededError } from './budget-policy.ts';

describe('BudgetPolicyEnforcer', () => {
  function createEnforcer(now = Date.now) {
    const storage = new MemoryStorage();
    const enforcer = new BudgetPolicyEnforcer(storage, now);
    return { storage, enforcer };
  }

  it('allows agent calls when no policy is set', async () => {
    const { enforcer } = createEnforcer();
    await expect(enforcer.checkBudget('default')).resolves.toBeUndefined();
  });

  it('allows agent calls within daily budget', async () => {
    const { enforcer } = createEnforcer();
    enforcer.setPolicy({ namespace: 'default', daily: { maxCost: 10.0 } });

    await enforcer.recordCost('default', 5.0);
    await expect(enforcer.checkBudget('default')).resolves.toBeUndefined();
  });

  it('rejects agent calls when daily budget exceeded', async () => {
    const { enforcer } = createEnforcer();
    enforcer.setPolicy({ namespace: 'default', daily: { maxCost: 10.0 } });

    await enforcer.recordCost('default', 10.5);

    const error = await enforcer.checkBudget('default').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrganizationBudgetExceededError);
    const budgetError = error as OrganizationBudgetExceededError;
    expect(budgetError.period).toBe('daily');
    expect(budgetError.namespace).toBe('default');
    expect(budgetError.costUsed).toBe(10.5);
    expect(budgetError.limit).toBe(10.0);
  });

  it('rejects agent calls when monthly budget exceeded', async () => {
    const { enforcer } = createEnforcer();
    enforcer.setPolicy({ namespace: 'default', monthly: { maxCost: 100.0 } });

    await enforcer.recordCost('default', 101.0);

    const error = await enforcer.checkBudget('default').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrganizationBudgetExceededError);
    const budgetError = error as OrganizationBudgetExceededError;
    expect(budgetError.period).toBe('monthly');
  });

  it('persists budget counters to storage', async () => {
    const fixedNow = new Date('2026-03-27T12:00:00Z').getTime();
    const { storage, enforcer } = createEnforcer(() => fixedNow);

    enforcer.setPolicy({ namespace: 'prod', daily: { maxCost: 50.0 } });
    await enforcer.recordCost('prod', 7.5);

    const dailyKey = KEYS.budget('prod', 'daily', '2026-03-27');
    const dailyData = await storage.get(dailyKey);
    expect(dailyData).toBeDefined();

    const decoded = decode(dailyData!) as { cost: number };
    expect(decoded.cost).toBe(7.5);
  });

  it('accumulates costs across multiple recordings', async () => {
    const fixedNow = new Date('2026-03-27T12:00:00Z').getTime();
    const { storage, enforcer } = createEnforcer(() => fixedNow);

    enforcer.setPolicy({ namespace: 'default', daily: { maxCost: 20.0 } });

    await enforcer.recordCost('default', 5.0);
    await enforcer.recordCost('default', 3.0);
    await enforcer.recordCost('default', 2.0);

    const dailyKey = KEYS.budget('default', 'daily', '2026-03-27');
    const dailyData = await storage.get(dailyKey);
    const decoded = decode(dailyData!) as { cost: number };
    expect(decoded.cost).toBe(10.0);

    // Still within budget
    await expect(enforcer.checkBudget('default')).resolves.toBeUndefined();
  });

  it('loads counters from storage on fresh enforcer', async () => {
    const fixedNow = new Date('2026-03-27T12:00:00Z').getTime();
    const storage = new MemoryStorage();

    // Pre-seed storage with existing counter
    const dailyKey = KEYS.budget('default', 'daily', '2026-03-27');
    await storage.put(dailyKey, encode({ cost: 9.0 }));

    const enforcer = new BudgetPolicyEnforcer(storage, () => fixedNow);
    enforcer.setPolicy({ namespace: 'default', daily: { maxCost: 10.0 } });

    // 9.0 < 10.0, so should be allowed
    await expect(enforcer.checkBudget('default')).resolves.toBeUndefined();

    // Adding 2.0 pushes to 11.0 > 10.0
    await enforcer.recordCost('default', 2.0);
    await expect(enforcer.checkBudget('default')).rejects.toThrow(OrganizationBudgetExceededError);
  });

  it('resets daily counter on new day', async () => {
    const storage = new MemoryStorage();

    // Day 1: record 8.0
    const day1 = new Date('2026-03-27T12:00:00Z').getTime();
    const enforcer1 = new BudgetPolicyEnforcer(storage, () => day1);
    enforcer1.setPolicy({ namespace: 'default', daily: { maxCost: 10.0 } });
    await enforcer1.recordCost('default', 8.0);

    // Day 2: fresh date means fresh counter
    const day2 = new Date('2026-03-28T12:00:00Z').getTime();
    const enforcer2 = new BudgetPolicyEnforcer(storage, () => day2);
    enforcer2.setPolicy({ namespace: 'default', daily: { maxCost: 10.0 } });

    // Should pass — new day starts at 0
    await expect(enforcer2.checkBudget('default')).resolves.toBeUndefined();
  });

  it('ignores recording when no policy exists for namespace', async () => {
    const { enforcer } = createEnforcer();
    // Should not throw
    await enforcer.recordCost('nonexistent', 100.0);
    await expect(enforcer.checkBudget('nonexistent')).resolves.toBeUndefined();
  });

  it('checks daily before monthly when both are set', async () => {
    const { enforcer } = createEnforcer();
    enforcer.setPolicy({
      namespace: 'default',
      daily: { maxCost: 5.0 },
      monthly: { maxCost: 100.0 },
    });

    await enforcer.recordCost('default', 6.0);

    const error = await enforcer.checkBudget('default').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrganizationBudgetExceededError);
    const budgetError = error as OrganizationBudgetExceededError;
    expect(budgetError.period).toBe('daily');
  });
});
