import {
  BulkDeleteRequiresTerminalWorkflowsError,
  BulkOperationConfirmationError,
  Engine,
  signal,
  type BulkOperationDryRunResult,
  type BulkSignalResult,
  type WorkflowContext,
  type WorkflowHandle,
} from 'weft';

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
const packageRootApprovalSignal = signal<{ approved: boolean }>('packageRootApproval');

engine.registerActivity(
  'packageRootFormatGreeting',
  async (input: PackageRootFormatGreetingInput) => `Hello, ${input.name}`,
);

// @ts-expect-error registered activities must match the public package-root augmentation.
engine.registerActivity('packageRootFormatGreeting', async (input: { id: string }) => input.id);

// @ts-expect-error registered activity names must match the public package-root augmentation.
engine.registerActivity('packageRootRuntimeFormatGreeting', async (input: { name: string }) => {
  return `Hello, ${input.name}`;
});

engine.register(
  'packageRootWelcome',
  async function* (ctx: WorkflowContext, input: PackageRootWelcomeInput) {
    const greeting = yield* ctx.run('packageRootFormatGreeting', { name: input.name });
    const approval = yield* ctx.waitForSignal(packageRootApprovalSignal);
    // @ts-expect-error string-name activity arguments must match the package-root augmentation.
    yield* ctx.run('packageRootFormatGreeting', { id: 'wrong' });
    // @ts-expect-error string-name activities must match the package-root augmentation.
    yield* ctx.run('packageRootRuntimeFormatGreeting', { name: input.name });
    approval.approved.valueOf();
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

async function verifyPackageRootBulkSignalTyping(): Promise<void> {
  const noPayloadPreview: BulkOperationDryRunResult = await engine.signalAll(
    { tags: ['nightly'] },
    'continue',
    undefined,
    { dryRun: true },
  );
  const preview: BulkOperationDryRunResult = await engine.signalAll(
    { tags: ['nightly'] },
    'continue',
    { approved: true },
    { dryRun: true },
  );
  const confirmed: BulkSignalResult = await engine.signalAll(
    { tags: ['nightly'] },
    'continue',
    { approved: true },
    { confirmationToken: preview.confirmationToken },
  );
  const legacyPayloadCommit: BulkSignalResult = await engine.signalAll(
    { tags: ['nightly'] },
    'continue',
    { approved: true },
  );
  const legacyRequestIdPayloadCommit: BulkSignalResult = await engine.signalAll(
    { tags: ['nightly'] },
    'continue',
    { requestId: 'payload-request' },
  );
  const confirmationError: BulkOperationConfirmationError = new BulkOperationConfirmationError();
  const terminalOnlyError: BulkDeleteRequiresTerminalWorkflowsError =
    new BulkDeleteRequiresTerminalWorkflowsError();
  void noPayloadPreview;
  void confirmed;
  void legacyPayloadCommit;
  void legacyRequestIdPayloadCommit;
  void confirmationError;
  void terminalOnlyError;
}
void verifyPackageRootBulkSignalTyping;

// @ts-expect-error workflow names must match the public package-root augmentation.
void engine.start('runtime-discovered-package-root', { id: 'dynamic' });
