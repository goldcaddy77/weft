import { activity, workflow } from '../src/index.ts';

interface CustomerProfileInput {
  customerId: string;
}

interface CustomerProfileOutput {
  customerId: string;
  loyaltyTier: string;
}

export const loadCustomerProfileActivity = activity({
  name: 'loadCustomerProfile',
  idempotent: true,
  execute: async (input: CustomerProfileInput): Promise<CustomerProfileOutput> => {
    return {
      customerId: input.customerId,
      loyaltyTier: 'gold',
    };
  },
});

export const customerProfileWorkflow = workflow({ name: 'customerProfile' })
  .activities({ loadCustomerProfile: loadCustomerProfileActivity })
  .execute(async function* (context, input: CustomerProfileInput) {
    return yield* context.run('loadCustomerProfile', input);
  });

export default {
  customerProfileWorkflow,
  loadCustomerProfileActivity,
};
