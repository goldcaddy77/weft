import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MCPTransportError } from './transport';
import { StdioTransport } from './transport-stdio';

// ---------------------------------------------------------------------------
// Helper: create a temporary script that acts as a mock MCP server
// ---------------------------------------------------------------------------

/**
 * Write a small Node/Bun script to a temp file that reads JSON-RPC from stdin
 * and writes JSON-RPC responses to stdout. Returns the script path.
 */
async function createMockServer(
  behavior: 'echo' | 'slow' | 'crash' | 'health' | 'malformed',
): Promise<string> {
  const scripts: Record<string, string> = {
    // Echoes back the method and params as the result
    echo: `
      const reader = require('readline').createInterface({ input: process.stdin });
      reader.on('line', (line) => {
        try {
          const msg = JSON.parse(line);
          const response = { jsonrpc: '2.0', id: msg.id, result: { method: msg.method, params: msg.params } };
          process.stdout.write(JSON.stringify(response) + '\\n');
        } catch {}
      });
    `,
    // Responds after 200ms delay
    slow: `
      const reader = require('readline').createInterface({ input: process.stdin });
      reader.on('line', (line) => {
        try {
          const msg = JSON.parse(line);
          setTimeout(() => {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: 'slow-ok' }) + '\\n');
          }, 200);
        } catch {}
      });
    `,
    // Exits immediately
    crash: `process.exit(1);`,
    // Sends non-JSON garbage before a valid response
    malformed: `
      const reader = require('readline').createInterface({ input: process.stdin });
      reader.on('line', (line) => {
        try {
          const msg = JSON.parse(line);
          // Send garbage first, then valid response
          process.stdout.write('this is not json\\n');
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: 'ok' }) + '\\n');
        } catch {}
      });
    `,
    // Responds to ping, then echoes
    health: `
      const reader = require('readline').createInterface({ input: process.stdin });
      reader.on('line', (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.method === 'ping') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
          } else {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { echo: msg.params } }) + '\\n');
          }
        } catch {}
      });
    `,
  };

  const scriptPath = join(tmpdir(), `mcp-mock-${behavior}-${Date.now()}.js`);
  await Bun.write(scriptPath, scripts[behavior]!);
  return scriptPath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StdioTransport', () => {
  const transports: StdioTransport[] = [];

  afterEach(() => {
    for (const transport of transports) {
      transport[Symbol.dispose]();
    }
    transports.length = 0;
  });

  function track(transport: StdioTransport): StdioTransport {
    transports.push(transport);
    return transport;
  }

  it('sends a JSON-RPC request and receives a response', async () => {
    const script = await createMockServer('echo');
    const transport = track(new StdioTransport({ command: 'bun', args: [script] }));

    const response = await transport.send({
      method: 'tools/list',
      params: { filter: 'all' },
    });

    expect(response.result).toEqual({
      method: 'tools/list',
      params: { filter: 'all' },
    });
  });

  it('handles multiple sequential requests with correct correlation', async () => {
    const script = await createMockServer('echo');
    const transport = track(new StdioTransport({ command: 'bun', args: [script] }));

    const r1 = await transport.send({ method: 'first' });
    const r2 = await transport.send({ method: 'second' });
    const r3 = await transport.send({ method: 'third' });

    expect((r1.result as any).method).toBe('first');
    expect((r2.result as any).method).toBe('second');
    expect((r3.result as any).method).toBe('third');
  });

  it('handles concurrent requests with correct correlation', async () => {
    const script = await createMockServer('echo');
    const transport = track(new StdioTransport({ command: 'bun', args: [script] }));

    const [r1, r2, r3] = await Promise.all([
      transport.send({ method: 'a' }),
      transport.send({ method: 'b' }),
      transport.send({ method: 'c' }),
    ]);

    expect((r1.result as any).method).toBe('a');
    expect((r2.result as any).method).toBe('b');
    expect((r3.result as any).method).toBe('c');
  });

  it('times out when server is slow', async () => {
    const script = await createMockServer('slow');
    const transport = track(new StdioTransport({ command: 'bun', args: [script], timeout: 50 }));

    await expect(transport.send({ method: 'test' })).rejects.toThrow(MCPTransportError);
  });

  it('respects external abort signal', async () => {
    const script = await createMockServer('slow');
    const transport = track(new StdioTransport({ command: 'bun', args: [script] }));

    const controller = new AbortController();

    const promise = transport.send({ method: 'test' }, controller.signal);
    controller.abort();

    await expect(promise).rejects.toThrow(DOMException);
  });

  it('throws when transport is disposed', async () => {
    const script = await createMockServer('echo');
    const transport = new StdioTransport({ command: 'bun', args: [script] });
    transport[Symbol.dispose]();

    await expect(transport.send({ method: 'test' })).rejects.toThrow(MCPTransportError);
  });

  it('rejects pending requests on dispose', async () => {
    const script = await createMockServer('slow');
    const transport = new StdioTransport({ command: 'bun', args: [script] });

    const promise = transport.send({ method: 'test' });

    // send() populates #pending synchronously before its first await,
    // so yielding the microtask queue is sufficient
    await Promise.resolve();
    transport[Symbol.dispose]();

    await expect(promise).rejects.toThrow(MCPTransportError);
  });

  it('warns on malformed JSON but still processes valid responses', async () => {
    const script = await createMockServer('malformed');
    const transport = track(new StdioTransport({ command: 'bun', args: [script] }));
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    const response = await transport.send({ method: 'test' });

    expect(response.result).toBe('ok');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[weft:mcp:stdio] Ignoring malformed JSON'),
    );

    warnSpy.mockRestore();
  });

  it('handles double dispose without error', async () => {
    const script = await createMockServer('echo');
    const transport = new StdioTransport({ command: 'bun', args: [script] });
    // Send one request to start the process
    await transport.send({ method: 'test' });
    transport[Symbol.dispose]();
    expect(() => transport[Symbol.dispose]()).not.toThrow();
  });

  describe('healthCheck', () => {
    it('returns true when server responds to ping', async () => {
      const script = await createMockServer('health');
      const transport = track(new StdioTransport({ command: 'bun', args: [script] }));

      expect(await transport.healthCheck()).toBe(true);
    });

    it('returns false when process crashes', async () => {
      const script = await createMockServer('crash');
      const transport = track(new StdioTransport({ command: 'bun', args: [script], timeout: 500 }));

      expect(await transport.healthCheck()).toBe(false);
    });
  });
});
