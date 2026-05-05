import { activity, type WorkflowRegistration } from '../src/index.ts';

export const formatGreetingActivity = activity({
  name: 'formatGreeting',
  idempotent: true,
  execute: async (input: string | undefined) => {
    const subject = typeof input === 'string' ? input.trim() || 'world' : 'world';
    return {
      greeting: `hello ${subject}`,
    };
  },
});

export const helloWorldWorkflow: WorkflowRegistration<string | undefined, { greeting: string }> = {
  handler: async function* (context, input) {
    return yield* context.run(formatGreetingActivity, input);
  },
};

export default {
  formatGreetingActivity,
  helloWorldWorkflow,
};
