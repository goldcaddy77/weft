import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { waitForRealTimersForTesting } from '../testing/fake-timers.ts';
import { runMcpStdioSession } from './stdio.ts';

type ParsedLine = {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string };
};

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register('echo-workflow', {
    description: 'Echo input through a durable workflow.',
    inputSchema: z.object({ value: z.string() }),
    handler: async function* (_context: WorkflowContext, input: { value: string }) {
      return { echoed: input.value };
    },
  });
  engine.register('hold-for-stdio-cancel', {
    description: 'Wait for cancellation or release.',
    inputSchema: z.object({ value: z.string().optional() }),
    handler: async function* (context: WorkflowContext) {
      return yield* context.waitForSignal<string>('release');
    },
  });
  return engine;
}

function controllableInput(): {
  stream: ReadableStream<Uint8Array>;
  send(message: Record<string, unknown>): void;
  close(): void;
} {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
    },
  });
  return {
    stream,
    send(message) {
      controller.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
    },
    close() {
      controller.close();
    },
  };
}

function collectingOutput(): {
  stream: WritableStream<Uint8Array>;
  lines(): ParsedLine[];
} {
  const decoder = new TextDecoder();
  let buffer = '';
  const lines: ParsedLine[] = [];
  return {
    stream: new WritableStream({
      write(chunk) {
        buffer += decoder.decode(chunk, { stream: true });
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (line.length > 0) lines.push(JSON.parse(line) as ParsedLine);
          newlineIndex = buffer.indexOf('\n');
        }
      },
    }),
    lines() {
      return [...lines];
    },
  };
}

async function waitForLine(
  output: { lines(): ParsedLine[] },
  predicate: (line: ParsedLine) => boolean,
): Promise<ParsedLine> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const found = output.lines().find(predicate);
    if (found) return found;
    await waitForRealTimersForTesting(10);
  }
  throw new Error('timed out waiting for MCP stdio line');
}

function toolText(result: unknown): unknown {
  const content = (result as { content: Array<{ type: 'text'; text: string }> }).content;
  return JSON.parse(content[0]!.text);
}

describe('runMcpStdioSession', () => {
  it('rejects empty startup-token admission before reading frames', async () => {
    const result = await runMcpStdioSession({
      input: controllableInput().stream,
      output: collectingOutput().stream,
      engine: createEngine(),
      admission: { kind: 'startup-token', token: '   ' },
    });

    expect(result).toEqual({
      exitCode: 2,
      reason: 'MCP stdio startup token must be non-empty',
    });
  });

  it('initializes, lists tools, calls workflow tools, and exits cleanly', async () => {
    const engine = createEngine();
    const input = controllableInput();
    const output = collectingOutput();

    const session = runMcpStdioSession({
      input: input.stream,
      output: output.stream,
      engine,
      admission: { kind: 'allow-unauthenticated-local-admin' },
    });

    input.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'stdio-test', version: '1.0.0' },
      },
    });
    await waitForLine(output, (line) => line.id === 1 && line.result !== undefined);

    input.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    input.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const toolsLine = await waitForLine(output, (line) => line.id === 2);
    const toolNames = (toolsLine.result as { tools: Array<{ name: string }> }).tools.map(
      (tool) => tool.name,
    );
    expect(toolNames).toContain('echo_workflow');

    input.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'echo_workflow', arguments: { value: 'stdio' } },
    });
    const callLine = await waitForLine(output, (line) => line.id === 3);
    expect(toolText(callLine.result)).toMatchObject({
      result: { echoed: 'stdio' },
      workflowId: expect.any(String),
    });

    input.close();
    const result = await session;
    expect(result.exitCode).toBe(0);
  });

  it('processes cancellation notifications while a workflow tool call is in flight', async () => {
    const engine = createEngine();
    const input = controllableInput();
    const output = collectingOutput();

    const session = runMcpStdioSession({
      input: input.stream,
      output: output.stream,
      engine,
      admission: { kind: 'allow-unauthenticated-local-admin' },
    });

    input.send({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'stdio-test', version: '1.0.0' },
      },
    });
    await waitForLine(output, (line) => line.id === 'init');

    input.send({
      jsonrpc: '2.0',
      id: 'pending',
      method: 'tools/call',
      params: { name: 'hold_for_stdio_cancel', arguments: { value: 'cancel' } },
    });

    let workflowId: string | undefined;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && workflowId === undefined) {
      const workflows = await engine.list({ type: 'hold-for-stdio-cancel' });
      workflowId = workflows.items.find((workflow) => workflow.status === 'running')?.id;
      if (workflowId === undefined) await waitForRealTimersForTesting(10);
    }
    expect(workflowId).toBeTruthy();

    input.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'pending', reason: 'stdio test cancellation' },
    });

    const cancelledLine = await waitForLine(output, (line) => line.id === 'pending');
    expect((cancelledLine.result as { isError?: boolean }).isError).toBe(true);

    input.close();
    const result = await session;
    expect(result.exitCode).toBe(0);
  });
});
