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

```typescript partial
import { Engine, MemoryStorage } from 'weft';

const engine = new Engine({ storage: new MemoryStorage() });

async function greet(name: string) {
  return `Hello, ${name}!`;
}

async function notify(message: string) {
  return `Notified: ${message}`;
}

engine.register('welcome', async function* (ctx, input: { name: string }) {
  const greeting = yield* ctx.run(greet, input.name);
  yield* ctx.run(notify, greeting);
  return { greeting, notified: true };
});

const handle = await engine.start('welcome', { name: 'World' });
const result = await handle.result();
console.log(result);
// { greeting: "Hello, World!", notified: true }
```

Run it:

```bash
bun run index.ts
```

That's a durable workflow. Let's break down what just happened.

### Step-based alternative

If generators are unfamiliar, you can write the same workflow with plain `async`/`await`:

```typescript partial
import { Engine, MemoryStorage } from 'weft';

const engine = new Engine({ storage: new MemoryStorage() });

async function greet(name: string) {
  return `Hello, ${name}!`;
}

async function notify(message: string) {
  return `Notified: ${message}`;
}

engine.register('welcome', async (ctx, input) => {
  const { name } = input as { name: string };
  const greeting = await ctx.step('greet', () => greet(name));
  await ctx.step('notify', () => notify(greeting));
  return { greeting, notified: true };
});

const handle = await engine.start('welcome', { name: 'World' });
const result = await handle.result();
console.log(result);
// { greeting: "Hello, World!", notified: true }
```

Each `ctx.step()` call is a checkpoint boundary. The engine converts this to the generator form at registration time. When you need features like durable timers, signals, or parallel execution, switch to the generator API shown above.

## How It Works

The workflow is a **generator function**---notice the `function*` and the `yield*` keywords. If you haven't used generators much, here's the mental model: every `yield*` is a checkpoint boundary. The engine runs the generator until it hits a `yield*`, records the result of that operation, and saves the workflow's position to storage. If the process dies and restarts, the engine loads the last checkpoint and resumes from that exact point.

There's no replay happening here. Weft doesn't re-execute your workflow from the beginning and try to match up results. It literally picks up where it left off. That's why you don't need to worry about determinism---your workflow code can use `Date.now()`, `Math.random()`, or anything else. The only rule is that side effects go inside activities (the functions you pass to `ctx.run()`).

`ctx.run(fn, args)` is how you run an **activity**. An activity is just an async function---nothing special about it. Weft executes it, captures the return value, and checkpoints it. If the activity fails, the engine retries it according to the retry policy (3 attempts with exponential backoff by default, when using the `activity({ ... })` registration helper).

`engine.register()` gives your workflow a name so the engine can find it. `engine.start()` kicks off a new execution and returns a handle. `handle.result()` waits for the workflow to finish and gives you the output.

## Adding a Sleep

Durable sleeps are one of the things that make this interesting. A normal `setTimeout` dies with the process. A Weft sleep survives restarts.

```typescript partial
engine.register('onboarding', async function* (ctx, input: { name: string }) {
  const greeting = yield* ctx.run(greet, input.name);
  yield* ctx.sleep('1h');
  yield* ctx.run(notify, `${input.name} completed onboarding`);
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
const double = async (n: number) => n * 2;
const triple = async (n: number) => n * 3;

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

Now your checkpoints live in a SQLite database on disk. Crash the process, restart it, and the workflow picks up where it left off. That's the whole point.

For quick experiments where you don't want to think about which adapter to pick, `resolveDefaultStorage()` detects the runtime and picks one for you (Bun → SQLite, Node → SQLite, browser → IndexedDB). The path goes under the OS temp directory; production deployments should pass `storage` explicitly.

```typescript
import { Engine } from 'weft';
import { resolveDefaultStorage } from 'weft/storage/auto';

await using storage = await resolveDefaultStorage();
await using engine = new Engine({ storage });
```

## Next Steps

You've got the fundamentals: activities, sleeps, signals, parallel execution, and persistent storage. Before diving deeper, take a look at the [Key Concepts](key-concepts.md) page to build a vocabulary for the rest of the documentation.
