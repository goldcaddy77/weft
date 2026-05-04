import { describe, it } from 'bun:test';

import type {
  ActivityInterceptor,
  Interceptor,
  WorkflowInterceptor,
} from './interceptor-interfaces.ts';

describe('Interceptor type drift', () => {
  it('accepts WorkflowInterceptor', () => {
    const workflowInterceptor: WorkflowInterceptor = {};
    const interceptor: Interceptor = workflowInterceptor;
    void interceptor;
  });

  it('accepts ActivityInterceptor', () => {
    const activityInterceptor: ActivityInterceptor = {};
    const interceptor: Interceptor = activityInterceptor;
    void interceptor;
  });

  it('accepts both-sided shape', () => {
    const interceptor: Interceptor = {
      *activity(interception, next) {
        return yield* next(interception);
      },
      async execute(interception, next) {
        return next(interception);
      },
    };
    void interceptor;
  });
});
