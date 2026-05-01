/**
 * Fired by {@link ProviderHealthTracker} when a provider's circuit breaker
 * trips to the open state after the error rate exceeds the configured threshold.
 * Carries the provider name, current error rate, threshold, and window duration.
 *
 * @example Alert when a provider circuit opens
 * ```ts
 * import { AgentProviderCircuitOpenEvent } from 'weft';
 *
 * const target = new EventTarget();
 *
 * target.addEventListener(AgentProviderCircuitOpenEvent.type, (e) => {
 *   const event = e as AgentProviderCircuitOpenEvent;
 *   console.error(
 *     `Circuit open for '${event.provider}': error rate ${(event.errorRate * 100).toFixed(0)}%`,
 *   );
 * });
 * ```
 */
export class AgentProviderCircuitOpenEvent extends Event {
  static readonly type = 'agent:provider:circuit-open' as const;
  readonly provider: string;
  readonly errorRate: number;
  readonly threshold: number;
  readonly windowDuration: number;

  constructor(provider: string, errorRate: number, threshold: number, windowDuration: number) {
    super(AgentProviderCircuitOpenEvent.type);
    this.provider = provider;
    this.errorRate = errorRate;
    this.threshold = threshold;
    this.windowDuration = windowDuration;
  }
}
