/**
 * OpenTelemetry adapter for Weft observability.
 *
 * @deprecated Use `createObservabilityInterceptors` from `weft/observability`
 * directly. The main interceptors now use `@opentelemetry/api` natively and
 * fall back to no-ops when the package is not installed.
 *
 * @module observability/opentelemetry
 */

export { createObservabilityInterceptors as createOpenTelemetryInterceptors } from './index';
export type { ObservabilityOptions as OpenTelemetryOptions } from './index';
