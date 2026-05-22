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
    // The activity's declared input is `string | undefined`; the builder's
    // typed `.activities()` entry tightens that to `string` (the non-undefined
    // half) because `ctx.run('name', input)` expects a concrete value when
    // the input position is required. Coerce the optional input here.
    return yield* context.run('formatGreeting', input ?? '');
  });

export default {
  formatGreetingActivity,
  helloWorldWorkflow,
};
