import { activity, workflow } from '../src/index.ts';

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

export const helloWorldWorkflow = workflow({ name: 'helloWorld' })
  .activities({ formatGreeting: formatGreetingActivity })
  .execute(async function* (context, input: string | undefined) {
    return yield* context.run('formatGreeting', input);
  });

export default {
  formatGreetingActivity,
  helloWorldWorkflow,
};
