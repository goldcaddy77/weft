# Definition Helpers

Weft's public definitions are object-shaped runtime values with enough metadata for registration, indexing, scheduling, and typed message surfaces.

## Activities

```ts
const normalizeEmail = activity(async function normalizeEmail(input: { email: string }) {
  return input.email.trim().toLowerCase();
});

const sendEmail = activity({
  name: 'sendEmail',
  queue: 'messages',
  timeout: '30s',
  execute: async (input: { email: string; body: string }) => {
    await provider.send(input);
  },
});
```

Bare activity functions must be named. Workflow calls use one input value plus optional call options:

```ts
yield * ctx.run(sendEmail, { email, body }, { queue: 'messages' });
```

## Workflows

```ts
const checkout = workflow({
  name: 'checkout',
  version: '1.0.0',
  searchAttributes: {
    customerId: searchAttribute<string>('customerId', 'string'),
  },
  handler: async function* checkout(ctx: WorkflowContext, input: { orderId: string }) {
    return yield* (ctx as Context).run(loadOrder, input);
  },
});

engine.register(checkout);
```

`workflow(namedGenerator)` is also supported. Anonymous bare workflow functions throw at definition time.

## Messages

```ts
const approval = signal<{ approved: boolean }>('approval');
const approve = update<{ reviewer: string }, { accepted: boolean }>('approve');
const status = query<{ verbose: boolean }, { state: string }>('status');

const payload = yield * ctx.waitForSignal(approval);
ctx.onUpdate(approve, (input) => ({ accepted: input.reviewer.length > 0 }));
ctx.onQuery(status, (input) => ({ state: input.verbose ? 'full' : 'summary' }));

await handle.signal(approval, { approved: true });
const result = await handle.update(approve, { reviewer: 'alice' });
const current = await handle.query(status, { verbose: false });
```

The runtime value for each handle is only `{ name }`; the generic parameters exist for compile-time payload and result inference. String names remain available for dynamic cases.

## Search Attributes

```ts
const customerId = searchAttribute<string>('customerId', 'string');
const createdAt = searchAttribute<Date>('createdAt', { type: 'string', format: 'date-time' });
const labels = searchAttribute<string[]>('labels', {
  type: 'array',
  items: { type: 'string' },
});

ctx.setAttribute(customerId, 'cust_123');
ctx.setAttribute(labels, ['priority', 'manual-review']);
```

Search attribute definitions normalize primitive strings and JSON Schema fragments into the existing validation and indexing path.

## Interceptors, Constraints, And Schedules

```ts
const tracing = interceptor({
  name: 'tracing',
  *activity(interception, next) {
    return yield* next(interception);
  },
});

const positiveBalance = constraint({
  name: 'positiveBalance',
  scope: 'account',
  check: () => true,
  onViolation: 'fail',
});

const dailyCheckoutSweep = schedule({
  workflow: checkout,
  cron: '0 9 * * *',
  input: { orderId: 'sweep' },
  overlapPolicy: 'skip',
});
```

Agents use the `agent({ ... })` helper.
