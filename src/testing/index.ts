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
