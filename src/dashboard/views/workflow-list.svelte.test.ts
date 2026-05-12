import { afterEach, describe, expect, it } from 'bun:test';

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { BunPlugin } from 'bun';
import { JSDOM } from 'jsdom';

import type {
  ApiClient,
  BulkCancelResult,
  BulkOperationDryRunResult,
  BulkTagMutationOperation,
  ListFilter,
  PaginatedResult,
  RetentionOverview,
  ScheduleSummary,
  WorkflowSummary,
} from '../api-client.ts';

type WorkflowListApiClient = Pick<
  ApiClient,
  | 'listWorkflows'
  | 'listSchedules'
  | 'getRetentionOverview'
  | 'getTenantQuotaUsage'
  | 'previewBulkCancelWorkflows'
  | 'commitBulkCancelWorkflows'
  | 'previewBulkDeleteWorkflows'
  | 'commitBulkDeleteWorkflows'
  | 'previewBulkSignalWorkflows'
  | 'commitBulkSignalWorkflows'
  | 'previewBulkTagWorkflows'
  | 'commitBulkTagWorkflows'
>;

type SvelteClientModule = {
  flushSync: () => void;
  mountWorkflowList: (target: Element, apiClient: WorkflowListApiClient) => unknown;
  unmountWorkflowList: (component: unknown) => void | Promise<void>;
};

const COMPONENT_DIRECTORY = new URL('.', import.meta.url).pathname;
const generatedFiles: string[] = [];
const generatedDirectories: string[] = [];
let flushSvelte = (): void => {};

afterEach(() => {
  for (const generatedFile of generatedFiles.splice(0)) {
    rmSync(generatedFile, { force: true });
  }
  for (const generatedDirectory of generatedDirectories.splice(0)) {
    rmSync(generatedDirectory, { force: true, recursive: true });
  }
});

function createDeferred<TValue>(): {
  promise: Promise<TValue>;
  resolve: (value: TValue | PromiseLike<TValue>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolvePromise: (value: TValue | PromiseLike<TValue>) => void = () => {};
  let rejectPromise: (reason?: unknown) => void = () => {};
  const promise = new Promise<TValue>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function loadWorkflowListHarnessModule(): Promise<SvelteClientModule> {
  const harnessPath = join(COMPONENT_DIRECTORY, `.workflow-list-harness.${crypto.randomUUID()}.ts`);
  const source = `
    import { flushSync, mount, unmount } from 'svelte';
    import WorkflowList from './workflow-list.svelte';
    import type { ApiClient } from '../api-client.ts';

    type WorkflowListApiClient = Pick<
      ApiClient,
      | 'listWorkflows'
      | 'listSchedules'
      | 'getRetentionOverview'
      | 'getTenantQuotaUsage'
      | 'previewBulkCancelWorkflows'
      | 'commitBulkCancelWorkflows'
      | 'previewBulkDeleteWorkflows'
      | 'commitBulkDeleteWorkflows'
      | 'previewBulkSignalWorkflows'
      | 'commitBulkSignalWorkflows'
      | 'previewBulkTagWorkflows'
      | 'commitBulkTagWorkflows'
    >;

    export { flushSync };

    export function mountWorkflowList(target: Element, apiClient: WorkflowListApiClient): unknown {
      return mount(WorkflowList, {
        target,
        props: {},
        context: new Map([['api-client', apiClient]]),
      });
    }

    export function unmountWorkflowList(component: unknown): void | Promise<void> {
      return unmount(component);
    }
  `;
  await Bun.write(harnessPath, source);
  generatedFiles.push(harnessPath);

  const sveltePluginSpecifier = 'bun-plugin-svelte';
  const sveltePluginModule = (await import(sveltePluginSpecifier)) as {
    SveltePlugin: (options: { forceSide: 'client'; development: boolean }) => BunPlugin;
  };
  const outputDirectory = join(
    COMPONENT_DIRECTORY,
    `.workflow-list-harness.${crypto.randomUUID()}.compiled`,
  );
  generatedDirectories.push(outputDirectory);

  const result = await Bun.build({
    entrypoints: [harnessPath],
    target: 'browser',
    format: 'esm',
    outdir: outputDirectory,
    plugins: [sveltePluginModule.SveltePlugin({ forceSide: 'client', development: false })],
  });

  expect(result.success).toBe(true);
  const outputPath = result.outputs[0]?.path;
  expect(outputPath).toBeString();
  if (outputPath === undefined) {
    throw new Error('Svelte component build did not produce an output file');
  }

  return (await import(pathToFileURL(outputPath).href)) as SvelteClientModule;
}

function installDom(): () => void {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
  });
  const replacements: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    SVGElement: dom.window.SVGElement,
    Text: dom.window.Text,
    Comment: dom.window.Comment,
    Document: dom.window.Document,
    DocumentFragment: dom.window.DocumentFragment,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLMediaElement: dom.window.HTMLMediaElement,
    HTMLSelectElement: dom.window.HTMLSelectElement,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    CustomEvent: dom.window.CustomEvent,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    navigator: dom.window.navigator,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback): number =>
      setTimeout(() => callback(Date.now()), 0) as unknown as number,
    cancelAnimationFrame: (handle: number): void => clearTimeout(handle),
  };
  const previousDescriptors = new Map<string, PropertyDescriptor | undefined>();

  for (const [key, value] of Object.entries(replacements)) {
    previousDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  return () => {
    for (const [key, descriptor] of previousDescriptors) {
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, key);
      } else {
        Object.defineProperty(globalThis, key, descriptor);
      }
    }
    dom.window.close();
  };
}

function createWorkflowSummary(id: string): WorkflowSummary {
  return {
    id,
    type: 'checkout',
    status: 'running',
    tags: ['nightly'],
    version: '1',
    createdAt: 1_000,
    updatedAt: 2_000,
  };
}

function createWorkflowListResult(): PaginatedResult<WorkflowSummary> {
  return {
    items: [createWorkflowSummary('workflow-1'), createWorkflowSummary('workflow-2')],
    total: 2,
    offset: 0,
    limit: 20,
  };
}

function createRetentionOverview(): RetentionOverview {
  return {
    defaultRetention: null,
    sweepIntervalMs: 60_000,
    sweepBatchSize: 100,
    nextSweepAt: null,
    workflowTypes: [],
  };
}

function createPreview(requestId: string): BulkOperationDryRunResult {
  return {
    dryRun: true,
    action: 'cancel',
    matched: 2,
    requestId,
    confirmationToken: 'bulk:test-confirmation-token',
    confirmationTokenVersion: 1,
    sampleWorkflowIds: ['workflow-1', 'workflow-2'],
    scope: {
      matched: 2,
      filter: { status: 'running' },
      statuses: ['running'],
      workflowTypes: ['checkout'],
      tenantIds: ['tenant-a'],
      sampleWorkflowIds: ['workflow-1', 'workflow-2'],
      sampleLimit: 20,
    },
  };
}

function createWorkflowListApiClient(
  options: {
    workflowListResponses?: Array<Promise<PaginatedResult<WorkflowSummary>>>;
    commitCancelResult?: Promise<BulkCancelResult>;
    commitCancelError?: Error;
  } = {},
): WorkflowListApiClient {
  const workflowListResponses = [...(options.workflowListResponses ?? [])];
  const defaultWorkflowListResponse = Promise.resolve(createWorkflowListResult());
  return {
    listWorkflows: () => workflowListResponses.shift() ?? defaultWorkflowListResponse,
    listSchedules: () =>
      Promise.resolve({
        items: [],
        total: 0,
        offset: 0,
        limit: 20,
      } satisfies PaginatedResult<ScheduleSummary>),
    getRetentionOverview: () => Promise.resolve(createRetentionOverview()),
    getTenantQuotaUsage: () => Promise.reject(new Error('not used by workflow-list tests')),
    previewBulkCancelWorkflows: (_filter: ListFilter, requestId: string) =>
      Promise.resolve(createPreview(requestId)),
    commitBulkCancelWorkflows: () =>
      options.commitCancelError !== undefined
        ? Promise.reject(options.commitCancelError)
        : (options.commitCancelResult ?? Promise.resolve({ cancelled: 2, failed: 0, errors: [] })),
    previewBulkDeleteWorkflows: (_filter: ListFilter, requestId: string) =>
      Promise.resolve({ ...createPreview(requestId), action: 'delete' }),
    commitBulkDeleteWorkflows: () => Promise.resolve({ deleted: 2 }),
    previewBulkSignalWorkflows: (
      _filter: ListFilter,
      _name: string,
      _payload: unknown,
      requestId: string,
    ) => Promise.resolve({ ...createPreview(requestId), action: 'signal' }),
    commitBulkSignalWorkflows: () => Promise.resolve({ signalled: 2, failed: 0 }),
    previewBulkTagWorkflows: (
      _filter: ListFilter,
      _tags: string[],
      operation: BulkTagMutationOperation,
      requestId: string,
    ) =>
      Promise.resolve({
        ...createPreview(requestId),
        action: operation === 'add' ? 'tag:add' : 'tag:remove',
      }),
    commitBulkTagWorkflows: () => Promise.resolve({ modified: 2 }),
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  flushSvelte();
}

function buttonWithText(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected to find button with label "${label}"`);
  }
  return button;
}

function statusFilterSelect(): HTMLSelectElement {
  const select = [...document.querySelectorAll('select')].find((candidate) =>
    [...candidate.options].some((option) => option.value === 'running'),
  );
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error('Expected to find the workflow status filter');
  }
  return select;
}

async function changeSelectValue(select: HTMLSelectElement, value: string): Promise<void> {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
}

async function clickButton(label: string): Promise<HTMLButtonElement> {
  const button = buttonWithText(label);
  button.click();
  await settle();
  return button;
}

async function mountWorkflowList(apiClient: WorkflowListApiClient): Promise<{
  cleanup: () => Promise<void>;
}> {
  const cleanupDom = installDom();
  const harnessModule = await loadWorkflowListHarnessModule();
  flushSvelte = harnessModule.flushSync;
  const mounted = harnessModule.mountWorkflowList(document.body, apiClient);
  flushSvelte();
  await settle();
  return {
    cleanup: async () => {
      await harnessModule.unmountWorkflowList(mounted);
      flushSvelte = (): void => {};
      cleanupDom();
    },
  };
}

describe('WorkflowList view', () => {
  it('requires a live dry-run preview before enabling bulk confirmation', async () => {
    const apiClient = createWorkflowListApiClient();
    const { cleanup } = await mountWorkflowList(apiClient);
    try {
      expect(buttonWithText('Confirm').disabled).toBe(true);

      await changeSelectValue(statusFilterSelect(), 'running');
      await clickButton('Preview');

      expect(document.body.textContent).toContain('Preview ready: cancel will affect 2 workflows.');
      expect(document.body.textContent).toContain('Matched tenants');
      expect(document.body.textContent).toContain('tenant-a');
      expect(buttonWithText('Cancel 2 workflows').disabled).toBe(false);

      const actionSelect = document.querySelector<HTMLSelectElement>('#bulk-action');
      if (actionSelect === null) throw new Error('Expected bulk action select');
      await changeSelectValue(actionSelect, 'delete');

      expect(document.body.textContent).not.toContain(
        'Preview ready: cancel will affect 2 workflows.',
      );
      expect(buttonWithText('Confirm').disabled).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('invalidates the current preview synchronously when a workflow-list refresh starts', async () => {
    const refreshResponse = createDeferred<PaginatedResult<WorkflowSummary>>();
    const apiClient = createWorkflowListApiClient({
      workflowListResponses: [
        Promise.resolve(createWorkflowListResult()),
        Promise.resolve(createWorkflowListResult()),
        refreshResponse.promise,
      ],
    });
    const { cleanup } = await mountWorkflowList(apiClient);
    try {
      await changeSelectValue(statusFilterSelect(), 'running');
      await clickButton('Preview');
      expect(buttonWithText('Cancel 2 workflows').disabled).toBe(false);

      buttonWithText('Refresh').click();
      flushSvelte();

      expect(document.body.textContent).not.toContain(
        'Preview ready: cancel will affect 2 workflows.',
      );
      expect(buttonWithText('Confirm').disabled).toBe(true);

      refreshResponse.resolve(createWorkflowListResult());
      await settle();
    } finally {
      await cleanup();
    }
  });

  it('shows confirmation-specific stale token errors and clears preview state', async () => {
    const apiClient = createWorkflowListApiClient({
      commitCancelError: new Error(
        'Bulk confirmation token does not match the current dry-run scope',
      ),
    });
    const { cleanup } = await mountWorkflowList(apiClient);
    try {
      await changeSelectValue(statusFilterSelect(), 'running');
      await clickButton('Preview');
      expect(buttonWithText('Cancel 2 workflows').disabled).toBe(false);

      await clickButton('Cancel 2 workflows');

      expect(document.body.textContent).toContain('Bulk confirmation failed');
      expect(document.body.textContent).toContain(
        'Preview expired. Run preview again before committing.',
      );
      expect(buttonWithText('Confirm').disabled).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
