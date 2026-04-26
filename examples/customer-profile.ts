import type { Context } from '../src/core/context.ts';
import type { WorkflowRegistration } from '../src/core/types.ts';
import { activity } from '../src/index.ts';

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
