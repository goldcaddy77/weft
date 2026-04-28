import { describe, expect, it } from 'bun:test';

import {
  customerProfileWorkflow,
  loadCustomerProfileActivity,
} from '../examples/customer-profile.ts';
import { formatGreetingActivity, helloWorldWorkflow } from '../examples/hello-world.ts';

describe('bundled examples', () => {
  it('trims greeting subjects before formatting the hello-world example output', async () => {
    await expect(formatGreetingActivity.execute('  John  ')).resolves.toEqual({
      greeting: 'hello John',
    });
  });

  it('runs the hello-world workflow through its activity', async () => {
    const iterator = helloWorldWorkflow.handler(
      {
        run: async function* (activity: typeof formatGreetingActivity, input: unknown) {
          return await activity.execute(input);
        },
      } as never,
      '  Jane  ',
    );

    await expect(iterator.next()).resolves.toEqual({
      value: { greeting: 'hello Jane' },
      done: true,
    });
  });

  it('loads a customer profile through the bundled customer-profile activity', async () => {
    await expect(loadCustomerProfileActivity.execute(42)).resolves.toEqual({
      customerId: '42',
      loyaltyTier: 'gold',
    });

    const iterator = customerProfileWorkflow.handler(
      {
        run: async function* (activity: typeof loadCustomerProfileActivity, input: unknown) {
          return await activity.execute(input);
        },
      } as never,
      42,
    );

    await expect(iterator.next()).resolves.toEqual({
      value: { customerId: '42', loyaltyTier: 'gold' },
      done: true,
    });
  });
});
