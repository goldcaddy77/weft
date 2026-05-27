import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const shouldRun = Bun.env['WEFT_BROWSER_SMOKE'] === '1';
const setupServiceWorkerModulePath = fileURLToPath(new URL('./setup.ts', import.meta.url));
const indexModulePath = fileURLToPath(new URL('../index.ts', import.meta.url));

type BrowserServer = ReturnType<typeof Bun.serve>;
type WorkflowBrowserState = {
  readonly id: string;
  readonly status: string;
  readonly result?: unknown;
};
type JsonRequestOptions = {
  readonly method?: string;
  readonly body?: unknown;
};
type WorkflowStatusPredicate = (state: WorkflowBrowserState) => boolean | Promise<boolean>;

let temporaryDirectory: string | undefined;
let server: BrowserServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;
let workflowStatusPredicateCounter = 0;

function requirePage(): Page {
  if (page === undefined) {
    throw new Error('Browser page was not initialized.');
  }
  return page;
}

function requireServerPort(): number {
  if (server === undefined) {
    throw new Error('Bun server was not initialized.');
  }
  if (server.port === undefined) {
    throw new Error('Bun server did not expose a port.');
  }
  return server.port;
}

function serviceWorkerEntrySource(): string {
  return `
/// <reference lib="webworker" />
import { setupServiceWorker } from ${JSON.stringify(setupServiceWorkerModulePath)};
import { activity, workflow } from ${JSON.stringify(indexModulePath)};

let activityRunCount = 0;

const countActivity = activity({
  name: 'count-activity',
  execute: async () => {
    activityRunCount += 1;
    return activityRunCount;
  },
});

const testWorkflow = workflow({ name: 'test-workflow' }).execute(async function* (ctx, _input) {
  const count = yield* ctx.run(countActivity);
  const signal = yield* ctx.waitForSignal('finish');
  return { activityCount: count, signalPayload: signal };
});

void setupServiceWorker({
  register(engine) {
    engine.register(testWorkflow);
  },
});
`;
}

async function writeBundledServiceWorker(directory: string): Promise<string> {
  const entryPath = join(directory, 'sw.ts');
  await Bun.write(entryPath, serviceWorkerEntrySource());

  const build = await Bun.build({
    entrypoints: [entryPath],
    format: 'esm',
    outdir: directory,
    target: 'browser',
  });

  if (!build.success) {
    const logs = build.logs.map((log) => log.message).join('\n');
    throw new Error(`Service Worker bundle failed:${logs.length > 0 ? `\n${logs}` : ''}`);
  }

  return join(directory, 'sw.js');
}

async function waitForServiceWorkerActivation(browserPage: Page): Promise<void> {
  await browserPage.waitForFunction(
    async () => {
      const registration = await navigator.serviceWorker.ready;
      return (
        navigator.serviceWorker.controller !== null && registration.active?.state === 'activated'
      );
    },
    undefined,
    { polling: 50, timeout: 10_000 },
  );
}

async function fetchJsonFromPage<T>(
  browserPage: Page,
  path: string,
  options: JsonRequestOptions = {},
): Promise<T> {
  const result = await browserPage.evaluate(
    async ({ bodyJson, method, path: requestPath }) => {
      const response = await fetch(requestPath, {
        method,
        ...(bodyJson === null
          ? {}
          : {
              body: bodyJson,
              headers: { 'Content-Type': 'application/json' },
            }),
      });
      const text = await response.text();
      const body = text.length === 0 ? null : JSON.parse(text);

      if (!response.ok) {
        throw new Error(`${method} ${requestPath} failed with ${response.status}: ${text}`);
      }

      return body;
    },
    {
      bodyJson: Object.hasOwn(options, 'body') ? JSON.stringify(options.body) : null,
      method: options.method ?? 'GET',
      path,
    },
  );

  return result as T;
}

async function startWorkflow(
  browserPage: Page,
  options: { readonly id?: string } = {},
): Promise<string> {
  const body = await fetchJsonFromPage<{ id: string }>(browserPage, '/weft/v1/workflows', {
    method: 'POST',
    body: {
      ...(options.id === undefined ? {} : { id: options.id }),
      input: null,
      type: 'test-workflow',
    },
  });
  return body.id;
}

async function signalWorkflow(
  browserPage: Page,
  workflowId: string,
  payload: unknown,
): Promise<void> {
  await fetchJsonFromPage<{ ok: true }>(
    browserPage,
    `/weft/v1/workflows/${encodeURIComponent(workflowId)}/signal/finish`,
    {
      method: 'POST',
      body: { payload },
    },
  );
}

async function readWorkflowResult(browserPage: Page, workflowId: string): Promise<unknown> {
  const body = await fetchJsonFromPage<{ result: unknown }>(
    browserPage,
    `/weft/v1/workflows/${encodeURIComponent(workflowId)}/result`,
  );
  return body.result;
}

async function waitForWorkflowStatus(
  browserPage: Page,
  port: number,
  id: string,
  predicate: WorkflowStatusPredicate,
  timeout: number,
): Promise<WorkflowBrowserState> {
  const workflowEndpoint = `http://127.0.0.1:${port}/weft/v1/workflows/${encodeURIComponent(id)}`;
  const exposedPredicateName = `__weftWorkflowStatusPredicate${workflowStatusPredicateCounter}`;
  workflowStatusPredicateCounter += 1;

  await browserPage.exposeFunction(exposedPredicateName, predicate);
  const handle = await browserPage.waitForFunction(
    async ({ endpoint, predicateName }) => {
      const response = await fetch(endpoint, { cache: 'no-store' });
      if (!response.ok) return false;

      const state = (await response.json()) as WorkflowBrowserState;
      const predicates = globalThis as unknown as Record<
        string,
        (state: WorkflowBrowserState) => boolean | Promise<boolean>
      >;
      return (await predicates[predicateName]!(state)) ? state : false;
    },
    { endpoint: workflowEndpoint, predicateName: exposedPredicateName },
    { polling: 50, timeout },
  );

  return (await handle.jsonValue()) as WorkflowBrowserState;
}

describe('Service Worker browser lifecycle', () => {
  beforeAll(async () => {
    if (!shouldRun) return;

    temporaryDirectory = mkdtempSync(join(tmpdir(), 'weft-sw-smoke-'));
    const serviceWorkerScriptPath = await writeBundledServiceWorker(temporaryDirectory);

    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (request.method === 'GET' && url.pathname === '/') {
          return new Response(
            '<!doctype html><meta charset="utf-8"><title>Weft Service Worker smoke</title><script>navigator.serviceWorker.register("/sw.js");</script>',
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
          );
        }

        if (request.method === 'GET' && url.pathname === '/sw.js') {
          return new Response(Bun.file(serviceWorkerScriptPath), {
            headers: {
              'Cache-Control': 'no-store',
              'Content-Type': 'application/javascript',
            },
          });
        }

        return new Response(null, { status: 404 });
      },
    });

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: 'load' });
    await waitForServiceWorkerActivation(page);
  });

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    server?.stop(true);

    if (temporaryDirectory !== undefined) {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it.skipIf(!shouldRun)('registers and activates Service Worker', async () => {
    const browserPage = requirePage();

    expect(await browserPage.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(
      true,
    );
    expect(await browserPage.evaluate(() => navigator.serviceWorker.controller?.state)).toBe(
      'activated',
    );
  });

  it.skipIf(!shouldRun)('responds to health check fetch via Service Worker', async () => {
    const browserPage = requirePage();

    expect(await browserPage.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(
      true,
    );
    await expect(fetchJsonFromPage(browserPage, '/weft/v1/health')).resolves.toEqual({
      status: 'ok',
    });
  });

  it.skipIf(!shouldRun)('starts workflow, parks on signal, resumes to completion', async () => {
    const browserPage = requirePage();
    const workflowId = await startWorkflow(browserPage);

    await waitForWorkflowStatus(
      browserPage,
      requireServerPort(),
      workflowId,
      (state) => state.status === 'running',
      5_000,
    );
    await signalWorkflow(browserPage, workflowId, 'done');
    await waitForWorkflowStatus(
      browserPage,
      requireServerPort(),
      workflowId,
      (state) => state.status === 'completed',
      5_000,
    );

    await expect(readWorkflowResult(browserPage, workflowId)).resolves.toEqual({
      activityCount: 1,
      signalPayload: 'done',
    });
  });

  it.skipIf(!shouldRun)(
    'resumes parked workflow after Service Worker termination without re-running completed activity',
    async () => {
      const browserPage = requirePage();
      const browserContext = context;
      if (browserContext === undefined) {
        throw new Error('Browser context was not initialized.');
      }

      const workflowId = `sw-terminated-${crypto.randomUUID()}`;
      await startWorkflow(browserPage, { id: workflowId });
      await waitForWorkflowStatus(
        browserPage,
        requireServerPort(),
        workflowId,
        (state) => state.status === 'running',
        5_000,
      );

      const cdp = await browserContext.newCDPSession(browserPage);
      await cdp.send('ServiceWorker.enable');
      await cdp.send('ServiceWorker.stopAllWorkers');
      await cdp.detach();

      await expect(fetchJsonFromPage(browserPage, '/weft/v1/health')).resolves.toEqual({
        status: 'ok',
      });
      await waitForServiceWorkerActivation(browserPage);

      await signalWorkflow(browserPage, workflowId, 'restarted');
      await waitForWorkflowStatus(
        browserPage,
        requireServerPort(),
        workflowId,
        (state) => state.status === 'completed',
        5_000,
      );

      await expect(readWorkflowResult(browserPage, workflowId)).resolves.toEqual({
        activityCount: 1,
        signalPayload: 'restarted',
      });
    },
  );
});
