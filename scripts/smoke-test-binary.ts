#!/usr/bin/env bun

/**
 * Round-trip smoke test for the compiled Weft binaries.
 *
 * Two binaries are compiled with `bun build --compile`:
 *
 * 1. The production CLI entrypoint, `src/cli-main.ts` — proves that
 *    `final-5` (compile produces a working binary) holds for the CLI
 *    that ships to consumers. Verified by spawning it with `--help` and
 *    confirming a clean exit and the expected banner.
 *
 * 2. The smoke harness, `scripts/cli-smoke-main.ts` — embeds the
 *    hello-world workflow because the production CLI does not accept a
 *    `--workflows` flag. The harness binds to 127.0.0.1 on an OS-assigned
 *    port and announces itself with `SMOKE_READY <url>` on stdout. The
 *    driver then drives a full workflow lifecycle over JSON-RPC HTTP.
 *
 * Run with: `bun run scripts/smoke-test-binary.ts`
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type JsonRpcEnvelope =
  | { error: { code: number; data?: unknown; message: string }; result?: never }
  | { error?: never; result: unknown };

const BINARY_STARTUP_TIMEOUT_MS = 15_000;
const WORKFLOW_COMPLETION_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;
const SHUTDOWN_GRACE_MS = 5_000;

function isJsonRpcEnvelope(value: unknown): value is JsonRpcEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if ('error' in v) {
    return typeof v['error'] === 'object' && v['error'] !== null;
  }
  return 'result' in v;
}

function hasStatus(value: unknown): value is { result?: unknown; status: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['status'] === 'string'
  );
}

async function jsonRpc(url: string, method: string, params: unknown): Promise<unknown> {
  const response = await fetch(`${url}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = await response.json();
  if (!isJsonRpcEnvelope(raw)) {
    throw new Error(`Malformed JSON-RPC response from ${method}: ${JSON.stringify(raw)}`);
  }
  if ('error' in raw && raw.error) {
    throw new Error(`RPC error from ${method}: ${JSON.stringify(raw.error)}`);
  }
  return raw.result;
}

async function pollUntilCompleted(url: string, workflowId: string): Promise<unknown> {
  const deadline = Date.now() + WORKFLOW_COMPLETION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const raw = await jsonRpc(url, 'weft.workflows.get', { workflowId });
    if (!hasStatus(raw)) {
      throw new Error(`weft.workflows.get returned unexpected shape: ${JSON.stringify(raw)}`);
    }
    if (raw.status === 'completed') return raw.result;
    if (raw.status === 'failed' || raw.status === 'cancelled') {
      throw new Error(`Workflow ${workflowId} ended with status ${raw.status}`);
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Workflow ${workflowId} did not complete within ${WORKFLOW_COMPLETION_TIMEOUT_MS}ms`,
  );
}

async function waitForReady(process_: ReturnType<typeof Bun.spawn>): Promise<string> {
  const reader = process_.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = '';

  const timeoutPromise = new Promise<never>((_resolve, reject) =>
    setTimeout(
      () =>
        reject(
          new Error(
            `Timed out waiting for SMOKE_READY after ${BINARY_STARTUP_TIMEOUT_MS}ms (check stderr above)`,
          ),
        ),
      BINARY_STARTUP_TIMEOUT_MS,
    ),
  );

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeoutPromise]);
      if (done) {
        throw new Error('Binary exited before signalling SMOKE_READY (check stderr above)');
      }
      buffered += decoder.decode(value, { stream: true });
      const match = buffered.match(/SMOKE_READY (\S+)/);
      if (match) return match[1] ?? '';
    }
  } finally {
    reader.releaseLock();
  }
}

async function shutdownServer(server: ReturnType<typeof Bun.spawn>): Promise<void> {
  server.kill('SIGTERM');
  const escalation = setTimeout(() => server.kill('SIGKILL'), SHUTDOWN_GRACE_MS);
  await server.exited;
  clearTimeout(escalation);
}

async function compileBinary(entry: string, binaryPath: string): Promise<void> {
  console.log(`[smoke] Compiling ${entry} → ${binaryPath}…`);
  const build = Bun.spawn({
    cmd: ['bun', 'build', '--compile', '--outfile', binaryPath, entry],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const buildExit = await build.exited;
  if (buildExit !== 0) {
    const stderr = await new Response(build.stderr).text();
    throw new Error(`bun build --compile ${entry} failed (exit ${buildExit}):\n${stderr}`);
  }
  if (!existsSync(binaryPath)) {
    throw new Error(`Binary not found at ${binaryPath} after compile`);
  }
}

async function exerciseProductionCli(binaryPath: string): Promise<void> {
  console.log('[smoke] Exercising production CLI binary (--help)…');
  const probe = Bun.spawn({
    cmd: [binaryPath, '--help'],
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const probeExit = await probe.exited;
  if (probeExit !== 0) {
    throw new Error(`Production CLI binary exited ${probeExit} on --help`);
  }
  const stdout = await new Response(probe.stdout).text();
  if (!stdout.includes('weft') || !stdout.includes('Commands:')) {
    throw new Error(`Production CLI --help output looks wrong:\n${stdout}`);
  }
}

async function exerciseHarnessRoundTrip(binaryPath: string): Promise<void> {
  console.log('[smoke] Spawning harness binary…');
  const server = Bun.spawn({
    cmd: [binaryPath, '--port=0'],
    stdout: 'pipe',
    stderr: 'inherit',
  });

  try {
    const url = await waitForReady(server);
    console.log(`[smoke] Harness ready at ${url}`);

    console.log('[smoke] Calling weft.workflows.start…');
    const startRaw = await jsonRpc(url, 'weft.workflows.start', {
      type: 'helloWorld',
      input: 'Alice',
    });
    if (
      typeof startRaw !== 'object' ||
      startRaw === null ||
      typeof (startRaw as Record<string, unknown>)['id'] !== 'string'
    ) {
      throw new Error(`weft.workflows.start did not return an id: ${JSON.stringify(startRaw)}`);
    }
    const workflowId = (startRaw as { id: string }).id;
    console.log(`[smoke] Started workflow ${workflowId}`);

    console.log('[smoke] Polling weft.workflows.get until completed…');
    const result = await pollUntilCompleted(url, workflowId);
    if (
      typeof result !== 'object' ||
      result === null ||
      (result as Record<string, unknown>)['greeting'] !== 'hello Alice'
    ) {
      throw new Error(`Unexpected workflow result: ${JSON.stringify(result)}`);
    }
    console.log(`[smoke] Got expected result: ${JSON.stringify(result)}`);
  } finally {
    await shutdownServer(server);
  }
}

async function main(): Promise<void> {
  const buildDirectory = mkdtempSync(join(tmpdir(), 'weft-smoke-'));

  try {
    const productionBinary = join(buildDirectory, 'weft');
    const harnessBinary = join(buildDirectory, 'weft-smoke');

    await compileBinary('./src/cli-main.ts', productionBinary);
    await exerciseProductionCli(productionBinary);

    await compileBinary('./scripts/cli-smoke-main.ts', harnessBinary);
    await exerciseHarnessRoundTrip(harnessBinary);

    console.log('[smoke] PASS');
  } finally {
    rmSync(buildDirectory, { recursive: true, force: true });
  }
}

await main();
