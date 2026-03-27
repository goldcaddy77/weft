/**
 * Organization-level budget policies with daily and monthly limits.
 *
 * Tracks cumulative LLM cost across all workflows in a namespace
 * and rejects new agent calls when limits are exceeded.
 *
 * @module ai/budget-policy
 */

import { decode, encode } from '../core/codec.ts';
import type { Storage as WeftStorage } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BudgetPolicyOptions {
  namespace: string;
  daily?: { maxCost: number };
  monthly?: { maxCost: number };
}

interface BudgetPolicyCounter {
  dailyCost: number;
  dailyDate: string;
  monthlyCost: number;
  monthlyDate: string;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class OrganizationBudgetExceededError extends Error {
  readonly namespace: string;
  readonly period: 'daily' | 'monthly';
  readonly costUsed: number;
  readonly limit: number;

  constructor(namespace: string, period: 'daily' | 'monthly', costUsed: number, limit: number) {
    super(
      `Organization budget exceeded: ${namespace} ${period} cost $${costUsed.toFixed(2)} exceeds limit $${limit.toFixed(2)}`,
    );
    this.name = 'OrganizationBudgetExceededError';
    this.namespace = namespace;
    this.period = period;
    this.costUsed = costUsed;
    this.limit = limit;
  }
}

// ---------------------------------------------------------------------------
// BudgetPolicyEnforcer
// ---------------------------------------------------------------------------

export class BudgetPolicyEnforcer {
  #policies: Map<string, BudgetPolicyOptions> = new Map();
  #counters: Map<string, BudgetPolicyCounter> = new Map();
  #storage: WeftStorage;
  #getNow: () => number;

  constructor(storage: WeftStorage, getNow: () => number = Date.now) {
    this.#storage = storage;
    this.#getNow = getNow;
  }

  setPolicy(options: BudgetPolicyOptions): void {
    this.#policies.set(options.namespace, options);
  }

  get policies(): ReadonlyMap<string, BudgetPolicyOptions> {
    return this.#policies;
  }

  async checkBudget(namespace: string): Promise<void> {
    const policy = this.#policies.get(namespace);
    if (!policy) return;

    const counter = await this.#loadCounter(namespace);

    if (policy.daily?.maxCost !== undefined && counter.dailyCost >= policy.daily.maxCost) {
      throw new OrganizationBudgetExceededError(
        namespace,
        'daily',
        counter.dailyCost,
        policy.daily.maxCost,
      );
    }

    if (policy.monthly?.maxCost !== undefined && counter.monthlyCost >= policy.monthly.maxCost) {
      throw new OrganizationBudgetExceededError(
        namespace,
        'monthly',
        counter.monthlyCost,
        policy.monthly.maxCost,
      );
    }
  }

  async recordCost(namespace: string, cost: number): Promise<void> {
    if (cost <= 0) return;

    const policy = this.#policies.get(namespace);
    if (!policy) return;

    const counter = await this.#loadCounter(namespace);
    counter.dailyCost += cost;
    counter.monthlyCost += cost;

    // Persist atomically
    const now = new Date(this.#getNow());
    const dailyDate = now.toISOString().slice(0, 10);
    const monthlyDate = now.toISOString().slice(0, 7);

    await this.#storage.batch([
      {
        type: 'put',
        key: KEYS.budget(namespace, 'daily', dailyDate),
        value: encode({ cost: counter.dailyCost }),
      },
      {
        type: 'put',
        key: KEYS.budget(namespace, 'monthly', monthlyDate),
        value: encode({ cost: counter.monthlyCost }),
      },
    ]);
  }

  async #loadCounter(namespace: string): Promise<BudgetPolicyCounter> {
    const cached = this.#counters.get(namespace);
    const now = new Date(this.#getNow());
    const dailyDate = now.toISOString().slice(0, 10);
    const monthlyDate = now.toISOString().slice(0, 7);

    // If cached and dates match, return cached
    if (cached && cached.dailyDate === dailyDate && cached.monthlyDate === monthlyDate) {
      return cached;
    }

    // Load from storage
    const dailyData = await this.#storage.get(KEYS.budget(namespace, 'daily', dailyDate));
    const monthlyData = await this.#storage.get(KEYS.budget(namespace, 'monthly', monthlyDate));

    const dailyCost = dailyData ? (decode(dailyData) as { cost: number }).cost : 0;
    const monthlyCost = monthlyData ? (decode(monthlyData) as { cost: number }).cost : 0;

    const counter: BudgetPolicyCounter = { dailyCost, dailyDate, monthlyCost, monthlyDate };
    this.#counters.set(namespace, counter);
    return counter;
  }
}
