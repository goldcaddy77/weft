# Provider Health

LLM providers go down. Rate limits spike. API latency triples during peak hours. If your agent keeps hammering a failing provider, you waste time, tokens, and money on requests that won't succeed. `ProviderHealthTracker` implements a circuit breaker that detects unhealthy providers and temporarily excludes them from routing.

## Setup

```typescript
import { ProviderHealthTracker } from 'weft';

const healthTracker = new ProviderHealthTracker({
  windowDuration: 60_000, // 60-second sliding window
  errorThreshold: 0.5, // 50% error rate trips the circuit
  cooldownDuration: 30_000, // 30 seconds before retrying
  minimumRequests: 5, // Need at least 5 requests before evaluating
});
```

All options have sensible defaults:

| Option             | Default               | Description                                                |
| ------------------ | --------------------- | ---------------------------------------------------------- |
| `windowDuration`   | `60_000` (1 minute)   | Sliding window for error rate calculation                  |
| `errorThreshold`   | `0.5`                 | Error rate (0–1) that trips the circuit                    |
| `cooldownDuration` | `30_000` (30 seconds) | How long the circuit stays open before probing             |
| `minimumRequests`  | `5`                   | Minimum requests in the window before the circuit can trip |

The `minimumRequests` threshold prevents a single failed request from tripping the circuit. You need enough data points for the error rate to be meaningful.

## Recording results

After each LLM call, record whether it succeeded or failed:

```typescript
try {
  const response = await provider.chat(messages, options);
  healthTracker.recordSuccess('anthropic');
} catch (error) {
  healthTracker.recordFailure('anthropic');
  throw error;
}
```

When passed via `AgentOptions.healthTracker`, the loop consults the tracker for routing decisions. Explicit `recordSuccess()` / `recordFailure()` calls in your own provider wrapper ensure accurate tracking when using custom integration patterns outside `executeAgentLoop()`.

## Circuit states

Each provider independently moves through three states:

- **Closed**—normal operation. Requests go through. Error rate is tracked.
- **Open**—provider is unhealthy. Requests should be routed elsewhere. Entered when the error rate exceeds `errorThreshold` within the sliding window.
- **Half-open**—cooldown has elapsed. The next request is a probe. A single success closes the circuit (the provider proved itself healthy). A single failure reopens it.

Check a provider's state:

```typescript
const state = healthTracker.getState('anthropic');
// 'closed' | 'open' | 'half-open'

const healthy = healthTracker.isHealthy('anthropic');
// true if closed or half-open, false if open
```

Get the current error rate:

```typescript
const errorRate = healthTracker.getErrorRate('anthropic');
// 0.0 to 1.0
```

## State change callback

Register a callback to react when a provider's circuit state changes:

```typescript
healthTracker.onStateChange = (provider, from, to) => {
  console.warn(`Provider ${provider}: circuit ${from} → ${to}`);
};
```

This fires on every transition: closed-to-open, open-to-half-open, half-open-to-closed, and half-open-to-open (probe failed).

## Event integration

When a circuit opens, the engine dispatches `AgentProviderCircuitOpenEvent`:

```typescript
engine.addEventListener('agent:provider:circuit-open', (event) => {
  console.warn(
    `Provider ${event.provider} circuit opened:`,
    `${(event.errorRate * 100).toFixed(1)}% error rate`,
    `(threshold: ${(event.threshold * 100).toFixed(1)}%,`,
    `window: ${event.windowDuration}ms)`,
  );
});
```

For `AgentProviderCircuitOpenEvent` to fire on the engine, set `tracker.eventTarget = engine` (or any shared `EventTarget`). The agent loop wires this automatically when you pass `healthTracker` via `executeAgentLoop()`.

See the [observability guide](./agent-observability.md) for the full event reference.

## Integration with model routing

Provider health works best alongside [model routing](./agent-model-routing.md). When the health tracker reports a provider as unhealthy, the model router's fallback chain kicks in. A custom router can check health explicitly:

```typescript
import { customRouter } from 'weft';

const router = customRouter((context) => {
  if (healthTracker.isHealthy('anthropic')) {
    return { model: 'claude-sonnet-4-20250514', fallback: ['gpt-4o'] };
  }
  return { model: 'gpt-4o', reason: 'anthropic-circuit-open' };
});
```

The circuit breaker and the model router are separate concerns that compose naturally. The health tracker observes; the router decides.
