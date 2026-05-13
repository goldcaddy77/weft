import { activity, type WorkflowRegistration } from 'weft';

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

export const customerProfileWorkflow: WorkflowRegistration<
  CustomerProfileInput,
  CustomerProfileOutput
> = {
  handler: async function* (context, input) {
    return yield* context.run(loadCustomerProfileActivity, input);
  },
};

export default {
  customerProfileWorkflow,
  loadCustomerProfileActivity,
};
