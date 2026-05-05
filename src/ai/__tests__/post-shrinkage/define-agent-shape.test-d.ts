import { defineAgent } from '../../declaration.ts';

defineAgent({ name: 'ok', model: 'claude-3' });
defineAgent({
  name: 'ok',
  model: 'claude-3',
  systemPrompt: 'help',
  maxTurns: 5,
  description: 'test',
});

// @ts-expect-error budget is not a valid field
defineAgent({ name: 'x', model: 'y', budget: {} });

// @ts-expect-error modelRouter is not a valid field
defineAgent({ name: 'x', model: 'y', modelRouter: {} });

// @ts-expect-error contextStrategy is not a valid field
defineAgent({ name: 'x', model: 'y', contextStrategy: 'sliding' });

// @ts-expect-error hooks is not a valid field
defineAgent({ name: 'x', model: 'y', hooks: {} });

// @ts-expect-error toolsForTenant is not a valid field
defineAgent({ name: 'x', model: 'y', toolsForTenant: () => [] });

// @ts-expect-error validateInput is not a valid field
defineAgent({ name: 'x', model: 'y', validateInput: () => true });
