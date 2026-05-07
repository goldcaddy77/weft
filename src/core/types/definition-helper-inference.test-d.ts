/**
 * Type-level tests asserting that the schema-driven inference overloads on
 * the definition helpers produce the right `TInput` / `TOutput` types when a
 * Standard Schema is supplied — without requiring an explicit generic.
 */

import { z } from 'zod';

import { activity } from './activity.ts';
import {
  query,
  signal,
  update,
  type QueryDefinition,
  type SignalDefinition,
  type UpdateDefinition,
} from './message-handles.ts';
import { workflow } from './workflow-function.ts';

// ---------------------------------------------------------------------------
// Helper: type equality
// ---------------------------------------------------------------------------

type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

function expectType<T>(_value: T): void {
  // intentionally empty; runs at type-check time only
}

// ---------------------------------------------------------------------------
// signal()
// ---------------------------------------------------------------------------

const approvalSchema = z.object({ approved: z.boolean() });
const inferredSignal = signal('approval', { inputSchema: approvalSchema });
expectType<SignalDefinition<{ approved: boolean }>>(inferredSignal);

const explicitSignal = signal<{ approved: boolean }>('approval');
expectType<SignalDefinition<{ approved: boolean }>>(explicitSignal);

const _signalEquals: Equals<typeof inferredSignal, typeof explicitSignal> = true;
void _signalEquals;

// ---------------------------------------------------------------------------
// update()
// ---------------------------------------------------------------------------

const updateInputSchema = z.object({ id: z.string() });
const updateOutputSchema = z.object({ accepted: z.boolean() });

const inferredUpdate = update('approve', {
  inputSchema: updateInputSchema,
  outputSchema: updateOutputSchema,
});
expectType<UpdateDefinition<{ id: string }, { accepted: boolean }>>(inferredUpdate);

const inferredUpdateInputOnly = update('approve', {
  inputSchema: updateInputSchema,
});
expectType<UpdateDefinition<{ id: string }>>(inferredUpdateInputOnly);

// ---------------------------------------------------------------------------
// query()
// ---------------------------------------------------------------------------

const queryOutputSchema = z.object({ state: z.string() });

const inferredQueryOutputOnly = query('status', { outputSchema: queryOutputSchema });
expectType<QueryDefinition<unknown, { state: string }>>(inferredQueryOutputOnly);

const inferredQueryBoth = query('status', {
  inputSchema: z.object({ id: z.string() }),
  outputSchema: queryOutputSchema,
});
expectType<QueryDefinition<{ id: string }, { state: string }>>(inferredQueryBoth);

// ---------------------------------------------------------------------------
// workflow()
// ---------------------------------------------------------------------------

const workflowInputSchema = z.object({ orderId: z.string() });
const workflowOutputSchema = z.object({ shipped: z.boolean() });

const inferredWorkflow = workflow({
  name: 'checkout',
  inputSchema: workflowInputSchema,
  outputSchema: workflowOutputSchema,
  // eslint-disable-next-line require-yield
  handler: async function* (_ctx, input) {
    expectType<{ orderId: string }>(input);
    return { shipped: true };
  },
});
expectType<{ orderId: string }>(
  inferredWorkflow.handler.length === 0 ? ({} as { orderId: string }) : ({} as { orderId: string }),
);

// ---------------------------------------------------------------------------
// activity()
// ---------------------------------------------------------------------------

const activityInputSchema = z.object({ to: z.string() });
const activityOutputSchema = z.object({ sent: z.boolean() });

const inferredActivity = activity({
  name: 'sendEmail',
  inputSchema: activityInputSchema,
  outputSchema: activityOutputSchema,
  execute: async (input) => {
    expectType<{ to: string }>(input);
    return { sent: true };
  },
});

// Calling the activity with the inferred input type should typecheck.
void inferredActivity({ to: 'a@b.co' });
