import { activity, type WorkflowRegistration } from 'weft';

const formatGreetingActivity = activity({
  name: 'formatGreeting',
  execute: async (subject: string) => ({ greeting: `hello ${subject.trim()}` }),
});

export const helloWorldWorkflow: WorkflowRegistration<string, { greeting: string }> = {
  handler: async function* (context, subject) {
    return yield* context.run(formatGreetingActivity, subject);
  },
};
