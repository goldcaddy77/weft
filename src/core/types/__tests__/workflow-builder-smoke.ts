// Phase 1a smoke test — type-only. Confirms the helpers compose as intended.
// This file participates in `bun run typecheck` and acts as a load-bearing
// guard against regressions in the builder type chain. It will be expanded
// in Phase 1c.

import type { SignalDefinition } from '../message-handles.ts';
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
];
