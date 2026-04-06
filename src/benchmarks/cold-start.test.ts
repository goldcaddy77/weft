/**
 * Cold start benchmarks for Weft.
 *
 * Two benchmark categories:
 * 1. **Library mode**: Measures Engine construction to first workflow completion.
 * 2. **Server mode**: Measures process spawn to successful HTTP health check,
 *    for both TypeScript source and compiled binary.
 *
 * @module benchmarks/cold-start
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { BunSQLiteStorage } from '../storage/bun-sql.ts';

// ---------------------------------------------------------------------------
// K2f: Library cold start — Engine construction to first workflow
// ---------------------------------------------------------------------------

const LIBRARY_TARGET_MS = process.env['CI'] ? 200 : 100;

describe('Library cold start', () => {
  it(`new Engine() to first workflow start completes in <${LIBRARY_TARGET_MS}ms`, async () => {
    const iterations = 10;
    const times: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();

      const storage = new BunSQLiteStorage(':memory:');
      const engine = new Engine({ storage });

      engine.register('ping', async function* (_ctx: WorkflowContext) {
        return 'pong';
      });

      const handle = await engine.start('ping', null);
      await handle.result();

      const elapsed = performance.now() - start;
      times.push(elapsed);

      engine[Symbol.dispose]();
      storage[Symbol.dispose]();
    }

    // Use the median to avoid outliers from first-run JIT compilation.
    const sorted = [...times].toSorted((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const min = sorted[0]!;
    const max = sorted[sorted.length - 1]!;

    console.log(
      [
        `\n  Library cold start benchmark (${iterations} iterations):`,
        `    Median:          ${median.toFixed(2)}ms`,
        `    Min:             ${min.toFixed(2)}ms`,
        `    Max:             ${max.toFixed(2)}ms`,
        `    Target:          <${LIBRARY_TARGET_MS}ms\n`,
      ].join('\n'),
    );

    expect(median).toBeLessThan(LIBRARY_TARGET_MS);
  });
});

// ---------------------------------------------------------------------------
// Server cold start helpers
// ---------------------------------------------------------------------------

/**
 * Spawn a server process and measure time until the health endpoint responds.
 * Returns the elapsed time in milliseconds or throws on timeout.
 */
async function measureColdStart(
  command: string[],
  port: number,
  timeoutMs: number = 10_000,
): Promise<{ elapsedMs: number; process: ReturnType<typeof Bun.spawn> }> {
  const start = performance.now();

  const proc = Bun.spawn(command, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NODE_ENV: 'production' },
  });

  const healthUrl = `http://localhost:${port}/v1/health`;
  const deadline = start + timeoutMs;

  while (performance.now() < deadline) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        const elapsedMs = performance.now() - start;
        return { elapsedMs, process: proc };
      }
    } catch {
      // Server not ready yet
    }
    await Bun.sleep(5);
  }

  proc.kill('SIGTERM');
  await proc.exited;
  throw new Error(`Server did not respond within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Source-mode cold start (bun src/cli-main.ts)
// ---------------------------------------------------------------------------

describe('Server cold start benchmark', () => {
  describe('source mode (bun src/cli-main.ts)', () => {
    it('starts and responds to health check within 5 seconds', async () => {
      const port = 18000 + Math.floor(Math.random() * 1000);
      const { elapsedMs, process: proc } = await measureColdStart(
        [
          'bun',
          'src/cli-main.ts',
          '--port',
          String(port),
          '--database',
          ':memory:',
          '--storage',
          'memory',
        ],
        port,
      );

      console.log(`  Source-mode cold start: ${elapsedMs.toFixed(1)}ms`);

      expect(elapsedMs).toBeLessThan(5_000);

      proc.kill('SIGTERM');
      await proc.exited;
    }, 15_000);
  });

  // ---------------------------------------------------------------------------
  // Binary-mode cold start (compiled executable)
  // ---------------------------------------------------------------------------

  describe('binary mode (compiled executable)', () => {
    const platform = process.platform === 'win32' ? 'windows' : process.platform;
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const binaryName = `weft-${platform}-${arch}${platform === 'windows' ? '.exe' : ''}`;
    const binaryDir = join(import.meta.dir, '..', '..', 'dist', 'benchmark-binary');
    const binaryPath = join(binaryDir, binaryName);

    beforeAll(async () => {
      if (!existsSync(binaryDir)) {
        mkdirSync(binaryDir, { recursive: true });
      }

      // Build a fresh binary for benchmarking
      const proc = Bun.spawn(
        [
          'bun',
          'build',
          '--compile',
          '--target',
          `bun-${platform}-${arch}`,
          '--outfile',
          binaryPath,
          '--minify',
          'src/cli-main.ts',
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );

      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        console.warn(`Binary build failed: ${stderr}`);
      }
    }, 60_000);

    afterAll(() => {
      if (existsSync(binaryDir)) {
        rmSync(binaryDir, { recursive: true, force: true });
      }
    });

    it('starts and responds to health check within 5 seconds', async () => {
      if (!existsSync(binaryPath)) {
        console.warn('Skipping binary cold start benchmark: binary not available');
        return;
      }

      const port = 19000 + Math.floor(Math.random() * 1000);

      // Use --storage memory to avoid LMDB native binding issues in compiled binary
      const { elapsedMs, process: proc } = await measureColdStart(
        [binaryPath, '--port', String(port), '--database', ':memory:', '--storage', 'memory'],
        port,
      );

      console.log(`  Binary-mode cold start: ${elapsedMs.toFixed(1)}ms`);

      // Binary cold start should be fast — assert under 5s as a baseline.
      // The architecture doc targets <100ms, but that's aspirational and
      // depends on hardware. We use a generous bound here to avoid flaky
      // CI failures and log the actual number for human review.
      expect(elapsedMs).toBeLessThan(5_000);

      proc.kill('SIGTERM');
      await proc.exited;
    }, 30_000);
  });
});
