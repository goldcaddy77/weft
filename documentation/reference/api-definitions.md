# Definition Helpers

Weft's public definitions are object-shaped runtime values with enough metadata for registration, indexing, scheduling, and typed message surfaces.

## Activity definitions

```ts
import { activity } from 'weft';

const sendEmail = activity({
  name: 'sendEmail',
  queue: 'messages',
  timeout: '30s',
  execute: async (input: { email: string; body: string }) => {
    void input;
  },
});

void sendEmail;
```

Bare activity functions passed to `activity(fn)` must be named. Workflow calls use one input value plus optional call options.

In addition to the fields shown above, `ActivityDefinition` accepts `idempotent?: boolean` (informs saga and validation guidance), `verify`, `visibilityTimeout`, `compensate`, `resourceScope`, and a function-form `idempotencyKey`. See the JSDoc on `ActivityDefinition` for the full surface.

See [the activities guide](../guides/activities.md) for usage patterns and motivation.

## Workflows

```ts
import { workflow } from 'weft';
import type { WorkflowContext } from 'weft';

const checkout = workflow({
  name: 'checkout',
  version: '1.0.0',
  handler: async function* checkout(ctx: WorkflowContext, input: { orderId: string }) {
    return input.orderId;
  },
});

void checkout;
```

`workflow(namedGenerator)` is also supported. Anonymous bare workflow functions throw at definition time.

See [the workflows guide](../guides/workflows.md) for usage patterns and motivation.

## Messages

```ts
import { query, signal, update } from 'weft';
import type { QueryDefinition, SignalDefinition, UpdateDefinition, WorkflowContext } from 'weft';

const approval = signal<{ approved: boolean }>('approval');
const approve = update<{ reviewer: string }, { accepted: boolean }>('approve');
const orderStatus = query<{ verbose: boolean }, { state: string }>('status');

async function* approvalWorkflow(ctx: WorkflowContext) {
  const payload = yield* ctx.waitForSignal(approval);
  ctx.onUpdate(approve, (input) => ({ accepted: input.reviewer.length > 0 }));
  ctx.onQuery(orderStatus, (input) => ({ state: input.verbose ? 'full' : 'summary' }));
  return payload;
}

declare const handle: {
  signal(
    definition: SignalDefinition<{ approved: boolean }>,
    input: { approved: boolean },
  ): Promise<void>;
  update(
    definition: UpdateDefinition<{ reviewer: string }, { accepted: boolean }>,
    input: { reviewer: string },
  ): Promise<{ accepted: boolean }>;
  query(
    definition: QueryDefinition<{ verbose: boolean }, { state: string }>,
    input: { verbose: boolean },
  ): Promise<{ state: string }>;
};

await handle.signal(approval, { approved: true });
const result = await handle.update(approve, { reviewer: 'alice' });
const current = await handle.query(orderStatus, { verbose: false });

void approvalWorkflow;
void result;
void current;
```

The runtime value for each handle is only `{ name }`; the generic parameters exist for compile-time payload and result inference. String names remain available for dynamic cases.

## Search Attributes

```ts
import { searchAttribute } from 'weft';

const customerId = searchAttribute('customerId', 'string');
const labels = searchAttribute('labels', { type: 'array', items: { type: 'string' } });

void customerId;
void labels;
```

Search attribute definitions normalize primitive strings and JSON Schema fragments into the existing validation and indexing path.

See [the search attributes guide](../guides/search-attributes.md) for usage patterns and motivation.

## Interceptors, Constraints, And Schedules

```ts
import { constraint, interceptor, schedule, workflow } from 'weft';
import type { WorkflowContext, WorkflowInterceptor } from 'weft';

const tracing: WorkflowInterceptor & { name: string } = interceptor({
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

const checkout = workflow(async function* checkout(
  _ctx: WorkflowContext,
  input: { orderId: string },
) {
  return input.orderId;
});

const dailyCheckoutSweep = schedule({
  workflow: checkout,
  cron: '0 9 * * *',
  input: { orderId: 'sweep' },
  overlapPolicy: 'skip',
});

void tracing;
void positiveBalance;
void dailyCheckoutSweep;
```
