/**
 * Engine event-driven alert manager. Evaluates metric-based rules against
 * sliding time windows and dispatches alert:fired/alert:resolved events
 * with optional webhook notifications.
 *
 * @module alerting/alert-manager
 */

import { AlertFiredEvent, AlertResolvedEvent } from '../core/events.ts';
import { parseDuration } from '../core/scheduler.ts';
import { parseSize } from './parse-size.ts';
import { CounterWindow, HistogramWindow } from './sliding-window.ts';
import type { AlertRule, AlertState, AlertingOptions } from './types.ts';

export class AlertManager implements Disposable {
  #target: EventTarget;
  #options: AlertingOptions;
  #states: AlertState[];
  #windows: Map<number, CounterWindow | HistogramWindow>;
  #listeners: Array<{ type: string; handler: EventListener }>;
  #pendingWebhooks: Set<AbortController>;
  #getNow: () => number;

  constructor(
    target: EventTarget,
    options: AlertingOptions,
    getNow: () => number = Date.now,
  ) {
    this.#target = target;
    this.#options = options;
    this.#getNow = getNow;
    this.#pendingWebhooks = new Set();
    this.#listeners = [];

    // Initialize states for each rule (all start idle)
    this.#states = options.rules.map((rule) => ({
      rule,
      status: 'idle' as const,
      currentValue: 0,
    }));

    // Create windows for rules that specify one
    this.#windows = new Map();
    for (let i = 0; i < options.rules.length; i++) {
      const rule = options.rules[i]!;
      const windowMs = rule.window ? parseDuration(rule.window) : 60_000; // default 1m

      if (rule.metric === 'workflow.failure_rate') {
        this.#windows.set(i, new CounterWindow(windowMs));
      } else if (rule.metric === 'activity.p99_duration') {
        this.#windows.set(i, new HistogramWindow(windowMs));
      }
      // storage.size is not event-driven, skip
    }

    // Subscribe to engine events based on configured metrics
    this.#subscribeToEvents();
  }

  #subscribeToEvents(): void {
    const hasFailureRate = this.#options.rules.some(
      (rule) => rule.metric === 'workflow.failure_rate',
    );
    const hasDuration = this.#options.rules.some(
      (rule) => rule.metric === 'activity.p99_duration',
    );

    if (hasFailureRate) {
      // Success events
      for (const eventType of ['workflow:completed'] as const) {
        const handler = () => {
          const now = this.#getNow();
          for (let i = 0; i < this.#options.rules.length; i++) {
            const rule = this.#options.rules[i]!;
            if (rule.metric !== 'workflow.failure_rate') continue;
            const window = this.#windows.get(i) as CounterWindow;
            window.record(now, false);
            this.#evaluate(i);
          }
        };
        this.#listeners.push({ type: eventType, handler: handler as EventListener });
        this.#target.addEventListener(eventType, handler as EventListener);
      }

      // Failure events
      for (const eventType of [
        'workflow:failed',
        'workflow:timed-out',
        'workflow:cancelled',
      ] as const) {
        const handler = () => {
          const now = this.#getNow();
          for (let i = 0; i < this.#options.rules.length; i++) {
            const rule = this.#options.rules[i]!;
            if (rule.metric !== 'workflow.failure_rate') continue;
            const window = this.#windows.get(i) as CounterWindow;
            window.record(now, true);
            this.#evaluate(i);
          }
        };
        this.#listeners.push({ type: eventType, handler: handler as EventListener });
        this.#target.addEventListener(eventType, handler as EventListener);
      }
    }

    if (hasDuration) {
      const handler = (event: Event) => {
        const now = this.#getNow();
        // ActivityCompletedEvent has a `duration` property
        const duration = (event as Event & { duration: number }).duration;
        for (let i = 0; i < this.#options.rules.length; i++) {
          const rule = this.#options.rules[i]!;
          if (rule.metric !== 'activity.p99_duration') continue;
          const window = this.#windows.get(i) as HistogramWindow;
          window.record(now, duration);
          this.#evaluate(i);
        }
      };
      this.#listeners.push({ type: 'activity:completed', handler: handler as EventListener });
      this.#target.addEventListener('activity:completed', handler as EventListener);
    }
  }

  #evaluate(ruleIndex: number): void {
    const rule = this.#options.rules[ruleIndex]!;
    const state = this.#states[ruleIndex]!;
    const now = this.#getNow();

    let currentValue = 0;
    const threshold =
      typeof rule.threshold === 'string' ? parseSize(rule.threshold) : rule.threshold;

    if (rule.metric === 'workflow.failure_rate') {
      const window = this.#windows.get(ruleIndex) as CounterWindow;
      currentValue = window.rate(now);
    } else if (rule.metric === 'activity.p99_duration') {
      const window = this.#windows.get(ruleIndex) as HistogramWindow;
      currentValue = window.percentile(99, now);
    }

    state.currentValue = currentValue;

    if (currentValue >= threshold && state.status === 'idle') {
      state.status = 'firing';
      state.lastFiredAt = now;
      this.#target.dispatchEvent(
        new AlertFiredEvent(rule.metric, threshold, currentValue, rule.window),
      );
      this.#executeAction(rule, 'alert:fired', currentValue);
    } else if (currentValue < threshold && state.status === 'firing') {
      state.status = 'idle';
      state.lastResolvedAt = now;
      this.#target.dispatchEvent(
        new AlertResolvedEvent(rule.metric, threshold, currentValue, rule.window),
      );
      this.#executeAction(rule, 'alert:resolved', currentValue);
    }
  }

  #executeAction(
    rule: AlertRule,
    eventType: 'alert:fired' | 'alert:resolved',
    currentValue: number,
  ): void {
    if (rule.action === 'log') {
      console.warn(
        `[weft:alert] ${eventType}: ${rule.metric} = ${currentValue} (threshold: ${rule.threshold})`,
      );
    }
    if (rule.action === 'webhook') {
      this.#sendWebhooks(rule, eventType, currentValue);
    }
  }

  #sendWebhooks(
    rule: AlertRule,
    eventType: 'alert:fired' | 'alert:resolved',
    currentValue: number,
  ): void {
    const webhooks = this.#options.webhooks ?? [];
    for (const target of webhooks) {
      if (!target.events.includes(eventType)) continue;
      const controller = new AbortController();
      this.#pendingWebhooks.add(controller);
      const threshold =
        typeof rule.threshold === 'string' ? parseSize(rule.threshold) : rule.threshold;
      const payload = {
        event: eventType,
        alert: {
          metric: rule.metric,
          threshold,
          currentValue,
          window: rule.window,
          firedAt: this.#getNow(),
        },
        engine: { timestamp: this.#getNow() },
      };
      fetch(target.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
        .then(() => this.#pendingWebhooks.delete(controller))
        .catch(() => this.#pendingWebhooks.delete(controller));
    }
  }

  /** Get current state of all alert rules (for debugging/testing). */
  get states(): readonly AlertState[] {
    return this.#states;
  }

  [Symbol.dispose](): void {
    // Remove all event listeners from target
    for (const { type, handler } of this.#listeners) {
      this.#target.removeEventListener(type, handler);
    }
    this.#listeners = [];

    // Abort all pending webhook fetches
    for (const controller of this.#pendingWebhooks) {
      controller.abort();
    }
    this.#pendingWebhooks.clear();
  }
}
