import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'bun:test';
import { chromium } from 'playwright';

type SmokeResult =
  | {
      readonly ok: true;
      readonly afterDelete: boolean;
      readonly count: number;
      readonly keys: readonly string[];
      readonly value: readonly number[];
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly stack?: string;
    };

// Resolve Chromium from Playwright's pinned, per-OS binary (managed by
// `bunx playwright install --with-deps chromium`). This replaces hand-rolled
// PATH/Applications discovery, which was fragile across runners. An explicit
// `CHROMIUM_PATH` is honored as an opt-in override for a locally installed
// browser; an empty value falls through to the pinned binary.
//
// `chromium.executablePath()` returns a computed path without touching the
// filesystem in Playwright 1.60 (it does not throw when the browser is
// absent), but we guard it anyway so this top-level resolution can never break
// `bun test` collection on a machine that never ran `playwright install` — a
// resolution failure degrades to `null`, which skips the smoke below.
function resolveChromiumExecutable(): string | null {
  const override = Bun.env['CHROMIUM_PATH']?.trim();
  if (override) return override;
  try {
    return chromium.executablePath();
  } catch {
    return null;
  }
}

const chromiumExecutable = resolveChromiumExecutable();
const shouldRunChromiumSmoke =
  chromiumExecutable !== null && Bun.env['WEFT_CHROMIUM_EXTENSION_SMOKE'] === '1';
const webExtensionStorageSource = fileURLToPath(new URL('./web-extension.ts', import.meta.url));

async function withTimeout<T>(promise: Promise<T>, timeoutMilliseconds: number): Promise<T> {
  let timeout: Timer | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(`Timed out after ${timeoutMilliseconds}ms waiting for Chromium smoke test`),
          );
        }, timeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function writeExtension(extensionDirectory: string, reportUrl: string): Promise<void> {
  const entrypointPath = join(extensionDirectory, 'content-script.ts');
  const manifestPath = join(extensionDirectory, 'manifest.json');

  await Bun.write(
    manifestPath,
    JSON.stringify(
      {
        content_scripts: [
          {
            js: ['content-script.js'],
            matches: ['http://127.0.0.1/*'],
            run_at: 'document_idle',
          },
        ],
        host_permissions: [reportUrl.replace('/result', '/*')],
        manifest_version: 3,
        name: 'Weft WebExtensionStorage Smoke',
        permissions: ['storage'],
        version: '0.0.0',
      },
      null,
      2,
    ),
  );

  await Bun.write(
    entrypointPath,
    `
import { WebExtensionStorage } from ${JSON.stringify(webExtensionStorageSource)};

const reportUrl = ${JSON.stringify(reportUrl)};

async function report(payload) {
  await fetch(reportUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function runSmokeTest() {
  try {
    const storage = new WebExtensionStorage({ area: 'local' });
    await storage.put('smoke:key', new Uint8Array([0, 1, 2, 255]));

    const value = await storage.get('smoke:key');
    const keys = [];
    for await (const key of storage.keys('smoke:')) keys.push(key);
    const count = await storage.count('smoke:');

    await storage.deletePrefix('smoke:');
    const afterDelete = await storage.get('smoke:key');

    await report({
      ok: true,
      afterDelete: afterDelete === null,
      count,
      keys,
      value: Array.from(value ?? []),
    });
  } catch (error) {
    await report({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}

void runSmokeTest();
`,
  );

  const build = await Bun.build({
    entrypoints: [entrypointPath],
    format: 'iife',
    minify: false,
    outdir: extensionDirectory,
    target: 'browser',
  });
  if (!build.success) {
    throw new Error(build.logs.map((log) => log.message).join('\n'));
  }
}

describe('WebExtensionStorage Chromium smoke', () => {
  // This smoke launches an external browser and is intentionally opt-in. The
  // default suite covers WebExtensionStorage with deterministic fake
  // `browser.storage` and `chrome.storage` drivers.
  const runIfChromiumSmokeEnabled = shouldRunChromiumSmoke ? it : it.skip;

  runIfChromiumSmokeEnabled(
    'round-trips bytes through real chrome.storage.local',
    async () => {
      // Unreachable at runtime — `shouldRunChromiumSmoke` already requires a
      // non-null executable before this test is selected to run. The guard
      // exists only to narrow `string | null` to `string` for the `Bun.spawn`
      // launch site below.
      if (chromiumExecutable === null) {
        throw new Error('Chromium executable is required for this smoke test.');
      }

      const temporaryDirectory = mkdtempSync(join(tmpdir(), 'weft-web-extension-smoke-'));
      const extensionDirectory = join(temporaryDirectory, 'extension');
      const profileDirectory = join(temporaryDirectory, 'profile');
      mkdirSync(extensionDirectory, { recursive: true });

      let resolveResult: (result: SmokeResult) => void;
      const resultPromise = new Promise<SmokeResult>((resolve) => {
        resolveResult = resolve;
      });

      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          if (request.method === 'GET' && url.pathname === '/') {
            return new Response('<!doctype html><title>Weft smoke</title>', {
              headers: { 'Content-Type': 'text/html' },
            });
          }

          if (request.method !== 'POST' || url.pathname !== '/result') {
            return new Response(null, { status: 404 });
          }

          resolveResult((await request.json()) as SmokeResult);
          return Response.json({ ok: true });
        },
      });

      let chromiumProcess: ReturnType<typeof Bun.spawn> | undefined;

      try {
        await writeExtension(extensionDirectory, `http://127.0.0.1:${server.port}/result`);

        chromiumProcess = Bun.spawn(
          [
            chromiumExecutable,
            '--headless=new',
            '--disable-background-networking',
            '--disable-component-update',
            '--disable-dev-shm-usage',
            '--disable-extensions-except=' + extensionDirectory,
            '--disable-gpu',
            '--disable-sync',
            '--load-extension=' + extensionDirectory,
            '--metrics-recording-only',
            '--no-default-browser-check',
            '--no-first-run',
            '--password-store=basic',
            '--remote-debugging-port=0',
            '--use-mock-keychain',
            '--user-data-dir=' + profileDirectory,
            `http://127.0.0.1:${server.port}/`,
          ],
          {
            stderr: 'ignore',
            stdout: 'ignore',
          },
        );

        const result = await withTimeout(resultPromise, 15_000);
        expect(result).toEqual({
          ok: true,
          afterDelete: true,
          count: 1,
          keys: ['smoke:key'],
          value: [0, 1, 2, 255],
        });
      } finally {
        await server.stop(true);
        chromiumProcess?.kill();
        await chromiumProcess?.exited.catch(() => {});
        rmSync(temporaryDirectory, { force: true, recursive: true });
      }
    },
    20_000,
  );
});
