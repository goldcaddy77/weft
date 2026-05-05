# Hello World

Let's build a durable workflow from scratch. By the end of this page you'll have a working program that survives crashes, and you'll understand _why_ it works.

## Create a Project

Start with a fresh directory and install Weft:

```bash
mkdir weft-hello && cd weft-hello
bun init -y
bun add weft
```

## The Simplest Workflow

Create a file called `index.ts` and paste this:

```typescript
import {
  Engine,
  WorkflowAlreadyExistsError,
  activity,
  type Context,
  type WorkflowHandle,
  type WorkflowContext,
} from 'weft';
import { BunSQLiteStorage } from 'weft/storage/bun-sqlite';

const engine = new Engine({ storage: new BunSQLiteStorage('./weft.db') });

const formatGreeting = activity({
  name: 'formatGreeting',
  execute: async (input: { name: string }) => `Hello, ${input.name}!`,
});

const sendNotification = activity({
  name: 'sendNotification',
  execute: async (input: { message: string }) => `Notified: ${input.message}`,
});

engine.registerActivity(formatGreeting.name, formatGreeting);
engine.registerActivity(sendNotification.name, sendNotification);

engine.register('welcome', async function* (ctx: WorkflowContext, input: { name: string }) {
  const context = ctx as Context;
  const greeting = yield* context.run(formatGreeting, { name: input.name });
  yield* context.sleep('1s');
  yield* context.run(sendNotification, { message: greeting });
  return { greeting, notified: true };
});

await engine.recoverAll();

const workflowId = 'welcome:world';
const workflowInput = { name: 'World' };
let handle: WorkflowHandle;

try {
  handle = await engine.start('welcome', workflowInput, { id: workflowId });
} catch (error) {
  if (!(error instanceof WorkflowAlreadyExistsError)) throw error;
  handle = await engine.resume(workflowId).catch(() => engine.getHandle(workflowId));
}

const result = await handle.result();
console.log(result);
// { greeting: "Hello, World!", notified: true }
```

Run it:

```bash
bun run index.ts
```

That's a durable workflow with persistent storage and an explicit recovery path. Let's break down what just happened.

### Step-based alternative

If generators are unfamiliar, you can write the same workflow with plain `async`/`await`:

```typescript partial
import { Engine } from 'weft';
import { BunSQLiteStorage } from 'weft/storage/bun-sqlite';

const engine = new Engine({ storage: new BunSQLiteStorage('./weft.db') });

async function greet(name: string) {
  return `Hello, ${name}!`;
}

async function notify(message: string) {
  return `Notified: ${message}`;
}

engine.register('welcome', async (ctx, input: { name: string }) => {
  const greeting = await ctx.step('greet', () => greet(input.name));
  await ctx.step('notify', () => notify(greeting));
  return { greeting, notified: true };
});

const workflowInput = { name: 'World' };
const handle = await engine.start('welcome', workflowInput, { id: 'welcome:world' });
const result = await handle.result();
console.log(result);
// { greeting: "Hello, World!", notified: true }
```

Each `ctx.step()` call is a checkpoint boundary. The engine converts this to the generator form at registration time. When you need features like durable timers, signals, or parallel execution, switch to the generator API shown above.

## How It Works

The workflow is a **generator function**---notice the `function*` and the `yield*` keywords. If you haven't used generators much, here's the mental model: every `yield*` is a checkpoint boundary. The engine runs the generator until it hits a `yield*`, records the result of that operation, and saves the workflow's position to storage. If the process dies and restarts, the engine loads the last checkpoint and resumes from that exact point.

There's no replay happening here. Weft doesn't re-execute your workflow from the beginning and try to match up results. It literally picks up where it left off. That's why you don't need to worry about determinism---your workflow code can use `Date.now()`, `Math.random()`, or anything else. The only rule is that side effects go inside activities (the functions you pass to `ctx.run()`).

`ctx.run(activity, input)` is how you run an **activity**. An activity is a named unit of work registered with the engine. The function reference keeps local development ergonomic, but the durable dispatch key is the activity name. That is why the example registers `formatGreeting` and `sendNotification` before the workflow starts: remote workers receive an activity name plus serialized input, not your in-process closure.

`engine.register()` gives your workflow a name so the engine can find it. `engine.start()` kicks off a new execution and returns a handle. `handle.result()` waits for the workflow to finish and gives you the output.

`engine.start()` without `options.id` creates a brand-new workflow ID. If you want a rerun of the same script to pick up an existing execution, pass a stable id and handle the duplicate-start case as shown above. In a long-lived server process, call `engine.recoverAll()` during boot so workflows already stored as running are resumed.

## Adding a Sleep

Durable sleeps are one of the things that make this interesting. A normal `setTimeout` dies with the process. A Weft sleep survives restarts.

```typescript partial
engine.register('onboarding', async function* (ctx, input: { name: string }) {
  const greeting = yield* ctx.run(formatGreeting, { name: input.name });
  yield* ctx.sleep('1h');
  yield* ctx.run(sendNotification, { message: `${input.name} completed onboarding` });
  return { greeting, onboarded: true };
});
```

`yield* ctx.sleep('1h')` pauses the workflow for an hour. The engine persists a timer, and when it fires the workflow resumes. You can use compact duration strings like `'30s'`, `'5m'`, or `'2d'`, or pass milliseconds directly.

## Waiting for Signals

Workflows often need to wait for something external---a user clicking "approve," a webhook arriving, a payment confirmation. Signals handle this.

```typescript partial
engine.register('approval', async function* (ctx, input: { orderId: string }) {
  const approval = yield* ctx.waitForSignal<{ approved: boolean }>('approval');
  return { orderId: input.orderId, approved: approval.approved };
});

const handle = await engine.start('approval', { orderId: 'order-1' });

// Later, from an API handler or another process:
await engine.signal(handle.id, 'approval', { approved: true });

const result = await handle.result();
console.log(result);
// { orderId: "order-1", approved: true }
```

`yield* ctx.waitForSignal('approval')` pauses the workflow until someone sends a signal with that name. The workflow can wait for hours, days, or weeks---the checkpoint is in storage, costing nothing while it waits. When the signal arrives, the engine loads the checkpoint and resumes.

## Running Activities in Parallel

When you have independent work, run it concurrently with `ctx.all()`:

```typescript partial
const double = activity({
  name: 'double',
  execute: async (input: number) => input * 2,
});

const triple = activity({
  name: 'triple',
  execute: async (input: number) => input * 3,
});

engine.registerActivity(double.name, double);
engine.registerActivity(triple.name, triple);

engine.register('parallel', async function* (ctx, input: number) {
  const [doubled, tripled] = yield* ctx.all([ctx.run(double, input), ctx.run(triple, input)]);
  return { doubled, tripled };
});

const handle = await engine.start('parallel', 5);
const result = await handle.result();
console.log(result);
// { doubled: 10, tripled: 15 }
```

Both activities run concurrently and the workflow resumes when all of them complete.

## Using SQLite for Persistence

`MemoryStorage` is great for development, but everything vanishes when the process stops. For real durability, use `BunSQLiteStorage`:

```typescript
import { Engine } from 'weft';
import { BunSQLiteStorage } from 'weft/storage/bun-sqlite';

const engine = new Engine({
  storage: new BunSQLiteStorage('./weft.db'),
});
```

Now your checkpoints live in a SQLite database on disk. Crash the process, restart it, call `engine.recoverAll()` after registering the workflow and activities, and the workflow picks up where it left off. Persistent storage keeps the bytes; recovery tells the new engine process to own the work again.

For quick experiments where you don't want to think about which adapter to pick, `resolveDefaultStorage()` detects Bun or Node and picks the matching SQLite backend (it's not for browsers — use `IndexedDBStorage` directly there). The path goes under the OS temp directory; production deployments should pass `storage` explicitly.

```typescript
import { Engine } from 'weft';
import { resolveDefaultStorage } from 'weft/storage/auto';

await using storage = await resolveDefaultStorage();
await using engine = new Engine({ storage });
```

## Next Steps

You've got the fundamentals: activities, sleeps, signals, parallel execution, and persistent storage. Before diving deeper, take a look at the [Key Concepts](key-concepts.md) page to build a vocabulary for the rest of the documentation.
