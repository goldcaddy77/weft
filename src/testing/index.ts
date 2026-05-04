/**
 * Public testing primitives for weft consumers.
 *
 * Imported via `weft/testing` to keep production bundles free of
 * test-only code. Re-exports {@link TestEngine}, {@link TimeControl},
 * {@link ActivityMockRegistry}, and the chaos helpers.
 *
 * @module weft/testing
 */

// Bun 1.3.13 minifier workaround: pure re-export barrels
// (`export { X } from './m'`) emit invalid JavaScript with undeclared
// identifiers in `dist/`. Loading the bundle from Node throws
// `Export 'd' is not defined in module`. Rebinding each value to a
// local const before re-exporting forces the bundler to keep the
// reference live. Verified by reverting to direct re-exports:
// `bun run build && node -e "import('./dist/testing/index.js')"` fails.
// Remove this workaround once Bun ships the fix and CI proves a clean
// build with direct re-exports.
import { ChaosNonRetryableError, ChaosTimeoutError, ChaosTransientError, withChaos } from './chaos';
import { ActivityMockRegistry } from './mocks';
import { TestEngine } from './test-engine';
import { TimeControl } from './time-control';

const exportedActivityMockRegistry = ActivityMockRegistry;
const exportedChaosNonRetryableError = ChaosNonRetryableError;
const exportedChaosTimeoutError = ChaosTimeoutError;
const exportedChaosTransientError = ChaosTransientError;
const exportedTestEngine = TestEngine;
const exportedTimeControl = TimeControl;
const exportedWithChaos = withChaos;

export type { ChaosScenario, FaultClass } from './chaos';
export type { MockCall, MockedActivity, MockHandle } from './mocks';
export type { RunNOptions, RunNResult } from './test-engine';
export {
  exportedActivityMockRegistry as ActivityMockRegistry,
  exportedChaosNonRetryableError as ChaosNonRetryableError,
  exportedChaosTimeoutError as ChaosTimeoutError,
  exportedChaosTransientError as ChaosTransientError,
  exportedTestEngine as TestEngine,
  exportedTimeControl as TimeControl,
  exportedWithChaos as withChaos,
};
