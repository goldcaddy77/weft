# Definition Helpers

Weft's public definitions are object-shaped runtime values with enough metadata for registration, indexing, scheduling, and typed message surfaces.

## Activities

```ts
import { activity } from 'weft';

declare const provider: {
  send(input: { email: string; body: string }): Promise<void>;
};

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

void normalizeEmail;
void sendEmail;
```

Bare activity functions must be named. Workflow calls use one input value plus optional call options:

```ts
import { activity } from 'weft';
import type { Context, WorkflowContext } from 'weft';

const sendEmail = activity({
  name: 'sendEmail',
  execute: async (input: { email: string; body: string }) => {
    void input;
  },
});

async function* notify(ctx: WorkflowContext, input: { email: string; body: string }) {
  yield* (ctx as Context).run(sendEmail, input, { queue: 'messages' });
}

void notify;
```

## Workflows

```ts
import { activity, Engine, searchAttribute, workflow } from 'weft';
import type { Context, WorkflowContext } from 'weft';

const loadOrder = activity({
  name: 'loadOrder',
  execute: async (input: { orderId: string }) => ({
    customerId: 'cust_123',
    id: input.orderId,
  }),
});

const checkout = workflow({
  name: 'checkout',
  version: '1.0.0',
  searchAttributes: {
    customerId: searchAttribute('customerId', 'string'),
  },
  handler: async function* checkout(ctx: WorkflowContext, input: { orderId: string }) {
    const order = yield* (ctx as Context).run(loadOrder, input);
    return order;
  },
});

const engine = new Engine();
engine.register(checkout);
```

`workflow(namedGenerator)` is also supported. Anonymous bare workflow functions throw at definition time.

## Messages

```ts
import { query, signal, update } from 'weft';
import type {
  Context,
  QueryDefinition,
  SignalDefinition,
  UpdateDefinition,
  WorkflowContext,
} from 'weft';

const approval = signal<{ approved: boolean }>('approval');
const approve = update<{ reviewer: string }, { accepted: boolean }>('approve');
const orderStatus = query<{ verbose: boolean }, { state: string }>('status');

async function* approvalWorkflow(ctx: WorkflowContext) {
  const context = ctx as Context;
  const payload = yield* context.waitForSignal(approval);
  context.onUpdate(approve, (input) => ({ accepted: input.reviewer.length > 0 }));
  context.onQuery(orderStatus, (input) => ({ state: input.verbose ? 'full' : 'summary' }));
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
import type { SearchAttributeHandle, SearchAttributeValue } from 'weft';

declare const ctx: {
  setAttribute<TValue extends SearchAttributeValue>(
    attribute: SearchAttributeHandle<TValue>,
    value: TValue,
  ): void;
};

const customerId = searchAttribute('customerId', 'string');
const createdAt = searchAttribute('createdAt', { type: 'string', format: 'date-time' });
const labels = searchAttribute('labels', {
  type: 'array',
  items: { type: 'string' },
});

ctx.setAttribute(customerId, 'cust_123');
ctx.setAttribute(labels, ['priority', 'manual-review']);
ctx.setAttribute(createdAt, new Date());
```

Search attribute definitions normalize primitive strings and JSON Schema fragments into the existing validation and indexing path.

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

Agents use the `agent({ ... })` helper.
