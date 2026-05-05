import { Engine, type WorkflowContext, type WorkflowHandle } from 'weft';

interface PackageRootWelcomeInput {
  name: string;
}

interface PackageRootWelcomeOutput {
  greeting: string;
}

interface PackageRootFormatGreetingInput {
  name: string;
}

declare module 'weft' {
  interface WorkflowRegistry {
    packageRootWelcome: {
      input: PackageRootWelcomeInput;
      output: PackageRootWelcomeOutput;
    };
  }

  interface ActivityTypes {
    packageRootFormatGreeting: (input: PackageRootFormatGreetingInput) => Promise<string>;
  }
}

const engine = new Engine();

engine.registerActivity(
  'packageRootFormatGreeting',
  async (input: PackageRootFormatGreetingInput) => `Hello, ${input.name}`,
);

// @ts-expect-error registered activities must match the public package-root augmentation.
engine.registerActivity('packageRootFormatGreeting', async (input: { id: string }) => input.id);

engine.register(
  'packageRootWelcome',
  async function* (ctx: WorkflowContext, input: PackageRootWelcomeInput) {
    const greeting = yield* ctx.run('packageRootFormatGreeting', { name: input.name });
    // @ts-expect-error string-name activity arguments must match the package-root augmentation.
    yield* ctx.run('packageRootFormatGreeting', { id: 'wrong' });
    return { greeting };
  },
);

async function verifyPackageRootWorkflowTyping(): Promise<void> {
  const handle = await engine.start('packageRootWelcome', { name: 'Steve' });
  const typedHandle: WorkflowHandle<PackageRootWelcomeOutput> = handle;
  const output = await typedHandle.result();
  output.greeting.toUpperCase();
}
void verifyPackageRootWorkflowTyping;

// @ts-expect-error workflow input must match the public package-root augmentation.
void engine.start('packageRootWelcome', { id: 'wrong' });

// Dynamic names are still available to package consumers.
void engine.start('runtime-discovered-package-root', { id: 'dynamic' });
