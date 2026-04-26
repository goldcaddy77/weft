import type { Context } from '../src/core/context.ts';
import type { WorkflowRegistration } from '../src/core/types.ts';
import { activity } from '../src/index.ts';

export const formatGreetingActivity = activity({
  name: 'formatGreeting',
  idempotent: true,
  execute: async (input: string | undefined) => {
    const subject = input?.trim() ? input : 'world';
    return {
      greeting: `hello ${subject}`,
    };
  },
});

export const helloWorldWorkflow: WorkflowRegistration<string | undefined, { greeting: string }> = {
  handler: async function* (context, input) {
    return yield* (context as Context).run(formatGreetingActivity, input);
  },
};

export default {
  formatGreetingActivity,
  helloWorldWorkflow,
};
