// Phase 1a + 1b smoke test — type-only. Confirms the helpers compose as
// intended and the parameterised `WorkflowContext` exposes typed-key overloads
// without breaking legacy bare-`WorkflowContext` usage.
//
// This file participates in `bun run typecheck` and acts as a load-bearing
// guard against regressions in the builder type chain. It will be expanded in
// Phase 1c with full coverage of every overload variant.

import type { SignalDefinition, UpdateDefinition } from '../message-handles.ts';
import type {
  ActivityArgsFor,
  ActivityResultFor,
  NormalizeActivities,
  NormalizedActivityEntry,
  SignalPayload,
} from '../workflow-builder-helpers.ts';
import type {
  InitialBuilderState,
  MarkBuilderState,
  WorkflowAlreadyRegistered,
} from '../workflow-builder.ts';
import type { WorkflowContext } from '../workflow-context.ts';

// 1. NormalizeActivities turns a bare async function into a NormalizedActivityEntry.
type N1 = NormalizeActivities<{
  formatGreeting: (input: { name: string }) => Promise<string>;
}>;
declare const _n1: N1;
declare const _entry: NormalizedActivityEntry<{ name: string }, string>;
// Same shape.
const _entryFromN1: typeof _entry = _n1.formatGreeting;

// 2. ActivityArgsFor: [input] for required, [] for void, [] | [input] for optional.
type ArgsRequired = ActivityArgsFor<NormalizedActivityEntry<{ name: string }, string>>;
type ArgsVoid = ActivityArgsFor<NormalizedActivityEntry<void, string>>;
type ArgsOptional = ActivityArgsFor<NormalizedActivityEntry<{ name: string } | undefined, string>>;

const _argsRequired: ArgsRequired = [{ name: 'Ada' }];
const _argsVoid: ArgsVoid = [];
const _argsOpt1: ArgsOptional = [];
const _argsOpt2: ArgsOptional = [{ name: 'Ada' }];

// 3. ActivityResultFor unwraps the output type.
type Result = ActivityResultFor<NormalizedActivityEntry<{ name: string }, string>>;
const _result: Result = 'hello';

// 4. SignalPayload extracts payload from SignalDefinition.
type Payload = SignalPayload<SignalDefinition<{ approverId: string }>>;
const _payload: Payload = { approverId: 'p1' };

// 5. MarkBuilderState flips a single flag.
type AfterActivities = MarkBuilderState<InitialBuilderState, 'activities'>;
const _state: AfterActivities = {
  activities: true,
  signals: false,
  updates: false,
  queries: false,
  searchAttributes: false,
};

// 6. WorkflowAlreadyRegistered is not satisfied by a plain object — its phantom
// symbol blocks assignment, which is what makes the parameter-position
// rejection in `engine.register(workflow)` work at the type level.
type Brand = WorkflowAlreadyRegistered<'welcome'>;
// @ts-expect-error — plain object cannot satisfy the branded diagnostic.
const _brand: Brand = {};

// 7. Workflow-scoped WorkflowContext typed-key overloads (Phase 1b).
//
// Construct a context typed against a known activities/signals/updates map and
// confirm:
//   - `ctx.run('known', input)` infers the result type from the activity entry.
//   - `ctx.waitForSignal('approve')` returns the declared signal payload type.
//   - `ctx.waitForUpdate('rename')` returns the declared { payload, respond }
//     shape with the right generics.
type DemoActivities = {
  formatGreeting: NormalizedActivityEntry<{ name: string }, string>;
  ping: NormalizedActivityEntry<void, number>;
};
type DemoSignals = {
  approve: SignalDefinition<{ approverId: string }>;
};
type DemoUpdates = {
  rename: UpdateDefinition<{ next: string }, { ok: boolean }>;
};

declare const typedCtx: WorkflowContext<DemoActivities, DemoSignals, DemoUpdates>;

async function* _typedDemo() {
  // Activity-name overload, with input. Pin the result type via a typed sink.
  const greeting = yield* typedCtx.run('formatGreeting', { name: 'Ada' });
  void (greeting satisfies string);

  // Activity-name overload, void input (zero-arg call).
  const count = yield* typedCtx.run('ping');
  void (count satisfies number);

  // Signal name resolves to the declared payload.
  const approval = yield* typedCtx.waitForSignal('approve');
  void (approval.approverId satisfies string);

  // Update name resolves to the declared { payload, respond } shape.
  const update = yield* typedCtx.waitForUpdate('rename');
  void (update.payload.next satisfies string);
  update.respond({ ok: true });
}

// 8. Legacy bare-`WorkflowContext` callers still work because all five
// generics default to permissive shapes that de-prioritise the typed
// overloads.
declare const bareCtx: WorkflowContext;
async function* _bareDemo() {
  // String-name lookup falls through to the legacy `ActivityTypes`-driven
  // overload; result type is `unknown` when no module augmentation is in
  // scope. The call still typechecks.
  const result = yield* bareCtx.run('anyName');
  void result;
  // Signal definition path remains available.
  const handle: SignalDefinition<{ ok: boolean }> = { name: 'go' };
  const payload = yield* bareCtx.waitForSignal(handle);
  void (payload satisfies { ok: boolean });
}

void [
  _entryFromN1,
  _argsRequired,
  _argsVoid,
  _argsOpt1,
  _argsOpt2,
  _result,
  _payload,
  _state,
  _brand,
  _typedDemo,
  _bareDemo,
];
