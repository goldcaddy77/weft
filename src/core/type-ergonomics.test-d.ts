import {
  Engine,
  type WorkflowContext,
  type WorkflowHandle,
  type WorkflowRegistration,
} from '../index.ts';

interface WelcomeInput {
  name: string;
}

interface WelcomeOutput {
  greeting: string;
}

interface FormatGreetingInput {
  name: string;
}

declare module '../index.ts' {
  interface WorkflowRegistry {
    welcome: { input: WelcomeInput; output: WelcomeOutput };
    registered: { input: WelcomeInput; output: WelcomeOutput };
  }

  interface ActivityTypes {
    formatGreeting: (input: FormatGreetingInput) => Promise<string>;
  }
}

type RequiredWorkflowContextKeys =
  | 'agent'
  | 'all'
  | 'archive'
  | 'expose'
  | 'getAttribute'
  | 'getAttributes'
  | 'humanReview'
  | 'load'
  | 'map'
  | 'memo'
  | 'offload'
  | 'onUpdate'
  | 'pipe'
  | 'race'
  | 'reduce'
  | 'run'
  | 'runAll'
  | 'saga'
  | 'sessionState'
  | 'setAttribute'
  | 'setAttributes'
  | 'sleep'
  | 'startChild'
  | 'stream'
  | 'streamUrl'
  | 'suspendUntil'
  | 'waitForSignal'
  | 'waitForUpdate';

type MissingWorkflowContextKeys = Exclude<RequiredWorkflowContextKeys, keyof WorkflowContext>;
type AssertNever<T extends never> = T;

const workflowContextDriftGuard: AssertNever<MissingWorkflowContextKeys> = undefined as never;
void workflowContextDriftGuard;

const engine = new Engine();

engine.register('welcome', async function* (ctx: WorkflowContext, input: WelcomeInput) {
  const greeting = yield* ctx.run('formatGreeting', { name: input.name });
  // @ts-expect-error string-name activities must match their augmented input type.
  yield* ctx.run('formatGreeting', { id: 'wrong' });
  const signalPayload = yield* ctx.waitForSignal<{ approved: boolean }>('approval');
  const updatePayload = yield* ctx.waitForUpdate<{ suffix: string }>('rename');
  ctx.onUpdate('set-name', (payload: { name: string }) => payload.name);
  ctx.expose({ greeting: () => greeting });
  ctx.setAttribute('customer', input.name);
  const customer = ctx.getAttribute<string>('customer');
  const attributes = ctx.getAttributes();
  const child = yield* ctx.startChild<WelcomeOutput>('registered', input);
  const parallel = yield* ctx.all([ctx.run('formatGreeting', input), ctx.sleep(1)]);
  const raced = yield* ctx.race([ctx.run('formatGreeting', input)]);
  const offloadReference = yield* ctx.offload('welcome-output', async () => child);
  const loaded = yield* ctx.load<WelcomeOutput>(offloadReference);
  yield* ctx.archive('welcome-output', loaded);
  const streamReference = yield* ctx.stream('welcome-stream', async function* () {});
  const streamUrl = ctx.streamUrl(streamReference);
  const mapped = yield* ctx.map([input], 'registered');
  const reduced = yield* ctx.reduce([input], 'registered', { greeting: '' });
  const memoized = yield* ctx.memo('memo-key', () => input.name);
  const runAllResult = yield* ctx.runAll({
    formatGreeting: [async (value: WelcomeInput) => value.name, input],
  });
  const sagaResult = yield* ctx.saga<WelcomeOutput>([]);
  const session = ctx.sessionState('name', input.name);

  void signalPayload;
  void updatePayload;
  void customer;
  void attributes;
  void parallel;
  void raced;
  void streamUrl;
  void mapped;
  void reduced;
  void memoized;
  void runAllResult;
  void sagaResult;
  void session;

  return { greeting };
});

const registration: WorkflowRegistration<WelcomeInput, WelcomeOutput> = {
  handler: async function* (ctx: WorkflowContext, input: WelcomeInput) {
    return yield* ctx.run(async (value: WelcomeInput) => ({ greeting: value.name }), input);
  },
};
engine.register('registered', registration);

engine.registerActivity('formatGreeting', async (input: FormatGreetingInput) => {
  return `Hello, ${input.name}`;
});

// @ts-expect-error registered activities must match their augmented input type.
engine.registerActivity('formatGreeting', async (input: { id: string }) => input.id);

async function verifyHandleTyping(): Promise<void> {
  const handle = await engine.start('welcome', { name: 'Steve' });
  const typedHandle: WorkflowHandle<WelcomeOutput> = handle;
  const output = await handle.result();
  output.greeting.toUpperCase();
  void typedHandle;
}
void verifyHandleTyping;

// @ts-expect-error start input must match the augmented workflow input type.
void engine.start('welcome', { id: 'wrong' });

// Dynamic workflow names remain available for runtime-discovered workflows.
void engine.start('runtime-discovered', { id: 'dynamic' });

engine.register('runtime-discovered', async () => {
  return 'dynamic';
});
