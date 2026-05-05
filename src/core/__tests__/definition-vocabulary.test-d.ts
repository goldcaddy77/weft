import {
  Context,
  Engine,
  activity,
  constraint,
  query,
  schedule,
  searchAttribute,
  signal,
  update,
  workflow,
  type ContextOperationRequest,
  type WorkflowContext,
} from '../../index.ts';

declare const context: Context;
declare const engine: Engine;

function expectType<T>(value: T): void {
  void value;
}

const bareActivity = activity(async function double(input: number) {
  return input * 2;
});
expectType<Promise<number>>(bareActivity(2));

const metadataActivity = activity({
  name: 'formatGreeting',
  queue: 'messages',
  execute: async (input: { name: string }) => `Hello, ${input.name}`,
});
expectType<Promise<string>>(metadataActivity({ name: 'Ada' }));

const zeroInputActivity = activity({
  name: 'zeroInput',
  execute: async () => 'done',
});
expectType<Promise<string>>(zeroInputActivity());

context.run(metadataActivity, { name: 'Ada' });
context.run(zeroInputActivity);
// @ts-expect-error ctx.run accepts one input value plus optional ActivityCallOptions.
context.run(metadataActivity, { name: 'Ada' }, { name: 'Grace' });

const checkoutWorkflow = workflow(async function* checkout(
  _context: WorkflowContext,
  input: { orderId: string },
) {
  return input.orderId;
});

const metadataWorkflow = workflow({
  name: 'metadataCheckout',
  version: '1.0.0',
  searchAttributes: {
    customerId: { type: 'string' },
  },
  handler: async function* (_context: WorkflowContext, input: { orderId: string }) {
    return input.orderId.length;
  },
});

engine.register(checkoutWorkflow);
engine.register(metadataWorkflow);

const approvalSignal = signal<{ approved: boolean }>('approval');
const approveUpdate = update<{ reviewer: string }, { accepted: boolean }>('approve');
const statusQuery = query<{ verbose: boolean }, { status: string }>('status');
const noInputStatusQuery = query<void, { status: string }>('statusSummary');

expectType<Generator<ContextOperationRequest, { approved: boolean }, unknown>>(
  context.waitForSignal(approvalSignal),
);

context.onUpdate(approveUpdate, (input) => ({ accepted: input.reviewer.length > 0 }));
context.onQuery(statusQuery, (input) => ({ status: input.verbose ? 'verbose' : 'compact' }));
context.onQuery(noInputStatusQuery, () => ({ status: 'ok' }));

const priority = searchAttribute<number>('priority', 'number');
context.setAttribute(priority, 5);
expectType<number | undefined>(context.getAttribute(priority));
// @ts-expect-error searchAttribute handles carry their value type.
context.setAttribute(priority, 'high');

const invariant = constraint({
  name: 'positiveBalance',
  scope: 'account',
  check: () => true,
  onViolation: 'fail',
});
void invariant;

const recurringCheckout = schedule({
  workflow: checkoutWorkflow,
  cron: '0 * * * *',
  input: { orderId: 'ord_123' },
  overlapPolicy: 'skip',
});
void recurringCheckout;
