import { activity, workflow } from '../src/index.ts';

export const formatGreetingActivity = activity({
  name: 'formatGreeting',
  idempotent: true,
  execute: async (input: string) => {
    const subject = input.trim() || 'world';
    return {
      greeting: `hello ${subject}`,
    };
  },
});

export const helloWorldWorkflow = workflow({ name: 'helloWorld' })
  .activities({ formatGreeting: formatGreetingActivity })
  .execute(async function* (context, input: string) {
    return yield* context.run('formatGreeting', input);
  });

export default {
  formatGreetingActivity,
  helloWorldWorkflow,
};
