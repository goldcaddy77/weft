#!/usr/bin/env bun

/**
 * Round-trip smoke test for the compiled `weft-smoke` binary.
 *
 * Builds a self-contained binary from src/cli-smoke-main.ts (which embeds
 * the hello-world workflow), spawns it on an OS-assigned port, drives a
 * full workflow lifecycle over JSON-RPC HTTP, and asserts the result.
 *
 * Run with: `bun run scripts/smoke-test-binary.ts`
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type JsonRpcEnvelope =
  | { error: { code: number; data?: unknown; message: string }; result?: never }
  | { error?: never; result: unknown };

const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 15_000;

async function jsonRpc(url: string, method: string, params: unknown): Promise<unknown> {
  const response = await fetch(`${url}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const envelope = (await response.json()) as JsonRpcEnvelope;
  if ('error' in envelope && envelope.error) {
    throw new Error(`RPC error from ${method}: ${JSON.stringify(envelope.error)}`);
  }
  return envelope.result;
}

async function pollUntilCompleted(url: string, workflowId: string): Promise<unknown> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const handle = (await jsonRpc(url, 'weft.workflows.get', { workflowId })) as {
      result?: unknown;
      status: string;
    };
    if (handle.status === 'completed') {
      return handle.result;
    }
    if (handle.status === 'failed' || handle.status === 'cancelled') {
      throw new Error(`Workflow ${workflowId} ended with status ${handle.status}`);
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Workflow ${workflowId} did not complete within ${POLL_TIMEOUT_MS}ms`);
}

async function waitForReady(
  process_: ReturnType<typeof Bun.spawn>,
  stderrBuffer: { value: string },
): Promise<string> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const reader = process_.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) {
      throw new Error(
        `Binary exited before signalling SMOKE_READY. stderr:\n${stderrBuffer.value}`,
      );
    }
    buffered += decoder.decode(value, { stream: true });
    const match = buffered.match(/SMOKE_READY (\S+)/);
    if (match) {
      reader.releaseLock();
      return match[1] ?? '';
    }
  }
  throw new Error(`Timed out waiting for SMOKE_READY. stderr:\n${stderrBuffer.value}`);
}

async function captureStderr(
  process_: ReturnType<typeof Bun.spawn>,
  buffer: { value: string },
): Promise<void> {
  const reader = process_.stderr.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer.value += decoder.decode(value, { stream: true });
  }
}

async function main(): Promise<void> {
  const buildDirectory = mkdtempSync(join(tmpdir(), 'weft-smoke-'));
  const binaryPath = join(buildDirectory, 'weft-smoke');

  console.log(`[smoke] Building binary at ${binaryPath}…`);
  const build = Bun.spawn({
    cmd: ['bun', 'build', '--compile', '--outfile', binaryPath, './src/cli-smoke-main.ts'],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const buildExit = await build.exited;
  if (buildExit !== 0) {
    const stderr = await new Response(build.stderr).text();
    throw new Error(`bun build --compile failed (exit ${buildExit}):\n${stderr}`);
  }
  if (!existsSync(binaryPath)) {
    throw new Error(`Binary not found at ${binaryPath} after compile`);
  }

  console.log(`[smoke] Spawning binary…`);
  const server = Bun.spawn({
    cmd: [binaryPath, '--port=0'],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stderrBuffer = { value: '' };
  const stderrPromise = captureStderr(server, stderrBuffer);

  try {
    const url = await waitForReady(server, stderrBuffer);
    console.log(`[smoke] Binary ready at ${url}`);

    console.log('[smoke] Calling weft.workflows.start…');
    const startResult = (await jsonRpc(url, 'weft.workflows.start', {
      type: 'helloWorld',
      input: 'Alice',
    })) as { id: string };
    if (typeof startResult.id !== 'string' || startResult.id.length === 0) {
      throw new Error(`weft.workflows.start did not return an id: ${JSON.stringify(startResult)}`);
    }
    console.log(`[smoke] Started workflow ${startResult.id}`);

    console.log('[smoke] Polling weft.workflows.get until completed…');
    const result = (await pollUntilCompleted(url, startResult.id)) as { greeting: string };
    if (result?.greeting !== 'hello Alice') {
      throw new Error(`Unexpected workflow result: ${JSON.stringify(result)}`);
    }
    console.log(`[smoke] Got expected result: ${JSON.stringify(result)}`);
    console.log('[smoke] PASS');
  } finally {
    server.kill('SIGTERM');
    await server.exited;
    await stderrPromise;
    rmSync(buildDirectory, { recursive: true, force: true });
  }
}

await main();
