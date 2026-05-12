// This file exists to prove the generated `.d.ts` lands on the real
// `'weft'` module identity. The tsconfig `paths` mapping resolves
// `'weft'` to the in-repo source, so the module augmentation in
// `weft.generated.d.ts` extends the real `WorkflowRegistry` and
// `ActivityTypes` interfaces, not a hand-authored stub.

import { Engine } from 'weft';

const engine = new Engine();

// Positive: known workflow with the correct input shape narrows.
async function knownWorkflow(): Promise<void> {
  const handle = await engine.start('welcome', { name: 'Steve' });
  const output = await handle.result();
  output.greeting.toUpperCase();
}
void knownWorkflow;

// @ts-expect-error workflow input must match the augmented input type.
void engine.start('welcome', { wrongShape: true });

// Positive: ActivityTypes reference with correct input narrowing.
type ActivityTypesRef = import('weft').ActivityTypes;
type FormatGreetingFn = ActivityTypesRef['formatGreeting'];
const formatGreetingTest: FormatGreetingFn = async ({ name }) => `Hello ${name}`;
void formatGreetingTest;

// @ts-expect-error formatGreeting must accept { name: string } input.
const badFormatGreeting: FormatGreetingFn = async ({ wrongShape }) => 'fail';
void badFormatGreeting;

// Positive: ActivityTypes reference—ping with no input.
type PingFn = ActivityTypesRef['ping'];
const pingTest: PingFn = async () => 'pong';
void pingTest;
