import { describe, expect, it } from 'bun:test';

import { ActivityRegistry } from '../../core/activity-registry.ts';
import { activity } from '../../core/types.ts';
import { catalogActivities, catalogActivity } from './activity-adapter.ts';

describe('activity catalog adapter', () => {
  it('projects registered activity metadata without creating executable operations', () => {
    const registry = new ActivityRegistry();
    const sendEmail = activity({
      name: 'sendEmail',
      description: 'Sends transactional email.',
      tags: ['email'],
      queue: 'notifications',
      idempotent: true,
      execute: async (input: { to: string }) => `sent to ${input.to}`,
    });

    registry.register(sendEmail.name, sendEmail);

    expect(catalogActivity(registry.getDefinition('sendEmail')!)).toEqual({
      name: 'sendEmail',
      description: 'Sends transactional email.',
      tags: ['email'],
      queue: 'notifications',
      idempotent: true,
    });
    expect(catalogActivities(registry)).toEqual([
      {
        name: 'sendEmail',
        description: 'Sends transactional email.',
        tags: ['email'],
        queue: 'notifications',
        idempotent: true,
      },
    ]);
  });
});
