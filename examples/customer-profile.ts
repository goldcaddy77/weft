import { activity, type Context, type WorkflowRegistration } from '../src/index.ts';

export const loadCustomerProfileActivity = activity({
  name: 'loadCustomerProfile',
  idempotent: true,
  execute: async (input: unknown) => {
    const customerId = String(input);
    return {
      customerId,
      loyaltyTier: 'gold',
    };
  },
});

export const customerProfileWorkflow: WorkflowRegistration = {
  handler: async function* (context, input: unknown) {
    return yield* (context as Context).run(loadCustomerProfileActivity, input);
  },
};

export default {
  customerProfileWorkflow,
  loadCustomerProfileActivity,
};
