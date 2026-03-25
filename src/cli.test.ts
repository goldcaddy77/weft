import { describe, expect, it } from 'bun:test';

import { parseCliArguments } from './cli.ts';

describe('CLI argument parsing', () => {
  it('parses --port flag', () => {
    const result = parseCliArguments(['--port', '8080']);
    expect(result.port).toBe('8080');
  });

  it('parses -p short flag for port', () => {
    const result = parseCliArguments(['-p', '9999']);
    expect(result.port).toBe('9999');
  });

  it('defaults port to 7233', () => {
    const result = parseCliArguments([]);
    expect(result.port).toBe('7233');
  });

  it('parses --data flag', () => {
    const result = parseCliArguments(['--data', '/tmp/test.db']);
    expect(result.data).toBe('/tmp/test.db');
  });

  it('parses -d short flag for data', () => {
    const result = parseCliArguments(['-d', '/tmp/other.db']);
    expect(result.data).toBe('/tmp/other.db');
  });

  it('defaults data to ./weft.db', () => {
    const result = parseCliArguments([]);
    expect(result.data).toBe('./weft.db');
  });

  it('parses --help flag', () => {
    const result = parseCliArguments(['--help']);
    expect(result.help).toBe(true);
  });

  it('defaults help to false', () => {
    const result = parseCliArguments([]);
    expect(result.help).toBe(false);
  });

  it('parses multiple flags together', () => {
    const result = parseCliArguments(['--port', '3000', '--data', '/var/weft.db']);
    expect(result.port).toBe('3000');
    expect(result.data).toBe('/var/weft.db');
  });

  it('parses -h short flag for help', () => {
    const result = parseCliArguments(['-h']);
    expect(result.help).toBe(true);
  });

  it('allows positional arguments without error', () => {
    const result = parseCliArguments(['positional-arg', '--port', '5000']);
    expect(result.port).toBe('5000');
  });

  it('parses all flags combined', () => {
    const result = parseCliArguments(['-p', '4000', '-d', '/tmp/all.db', '-h']);
    expect(result.port).toBe('4000');
    expect(result.data).toBe('/tmp/all.db');
    expect(result.help).toBe(true);
  });

  it('throws on unknown flags due to strict mode', () => {
    expect(() => parseCliArguments(['--unknown-flag'])).toThrow();
  });
});

describe('CLI direct execution', () => {
  it('runs the CLI binary with --help and exits 0', async () => {
    const process = Bun.spawn(['bun', './src/cli.ts', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('weft');
    expect(stdout).toContain('--port');
    expect(stdout).toContain('--data');
    expect(stdout).toContain('--help');
  });

  it('runs the CLI binary with -h short flag and exits 0', async () => {
    const process = Bun.spawn(['bun', './src/cli.ts', '-h'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('weft');
  });

  it('starts the server and responds to health check', async () => {
    const port = 17233 + Math.floor(Math.random() * 1000);
    const process = Bun.spawn(
      ['bun', './src/cli.ts', '--port', String(port), '--data', ':memory:'],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    try {
      // Wait for server to start
      let started = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        await Bun.sleep(100);
        try {
          const response = await fetch(`http://localhost:${port}/v1/health`);
          if (response.ok) {
            started = true;
            break;
          }
        } catch {
          // Server not ready yet
        }
      }

      expect(started).toBe(true);
    } finally {
      process.kill('SIGTERM');
      await process.exited;
    }
  });
});
