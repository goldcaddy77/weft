// Phase 3 — type-only fixtures for `Engine.register(builderWorkflow)` and
// `Engine.create({ workflows })` flows. Every "test" is either an
// `@ts-expect-error` on a line that must fail to compile, or a `satisfies`
// assertion on a value whose inferred type must match the expected shape.
//
// Conventions inherited from `workflow-builder.test-d.ts`:
//   - No runtime assertions.
//   - One assertion per block. Comments explain the "why".

import { Engine } from '../../engine/index.ts';
import { workflow } from '../workflow-function.ts';

// ---------------------------------------------------------------------------
// engine.register(builderWorkflow) — bare-expression name-conflict guard
// ---------------------------------------------------------------------------

const welcome = workflow({ name: 'welcome' }).execute(async function* (
  _ctx,
  input: { name: string },
) {
  return { greeting: `hello ${input.name}` };
});

const another = workflow({ name: 'another' }).execute(async function* (
  _ctx,
  input: { id: number },
) {
  return input.id;
});

declare const engineOne: Engine;
const engineWithWelcome = engineOne.register(welcome);
const engineWithBoth = engineWithWelcome.register(another);

// New names widen the typed workflow registry. Both `start` lines must
// typecheck on the engine returned by the chained `register` calls.
void engineWithBoth.start('welcome', { name: 'Ada' });
void engineWithBoth.start('another', { id: 1 });

// engine.start with an unknown workflow name is a type error.
// @ts-expect-error: 'unknown-workflow' is not in the typed registry.
void engineWithBoth.start('unknown-workflow', {});

// Wrong input type fails to compile (input inference flows from the builder's
// generator function back through `Engine.register`).
// @ts-expect-error: { name } expected, number given.
void engineWithBoth.start('welcome', 42);

// ---------------------------------------------------------------------------
// engine.registerWorkflows(map) widens just like Engine.create({ workflows })
// ---------------------------------------------------------------------------

declare const freshEngine: Engine;
const engineFromMap = freshEngine.registerWorkflows({ welcome, another });
void engineFromMap.start('welcome', { name: 'Ada' });
void engineFromMap.start('another', { id: 1 });
