import { describe, expect, it } from 'bun:test';

import { formatGreetingActivity } from '../examples/hello-world.ts';

describe('bundled examples', () => {
  it('trims greeting subjects before formatting the hello-world example output', async () => {
    await expect(formatGreetingActivity.execute('  John  ')).resolves.toEqual({
      greeting: 'hello John',
    });
  });
});
