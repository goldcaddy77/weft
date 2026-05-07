import { describe, expect, it } from 'bun:test';

/**
 * Bun's test runner refuses `require('@valibot/to-json-schema')` mid-suite
 * with "Unexpected require target" — the require resolves cleanly when the
 * file is invoked on its own. The in-suite Valibot test (in
 * `definition-schema-to-json.test.ts`) probes that behavior and uses
 * `it.skipIf(!canLoadValibot)`, which means CI can stay green even if the
 * Valibot adapter regresses.
 *
 * This file closes that gap by spawning a fresh `bun test` subprocess that
 * runs only the sibling standalone file. The child's exit code is the gate:
 * any breakage in the Valibot conversion path (or any other case in that
 * file) fails this test. It is intentionally small — no DI, no fixtures —
 * and proves the shipped adapter path works under CI without restructuring
 * the loader.
 */
describe('definition-schema-to-json (subprocess gate)', () => {
  it('passes the full sibling test file when run as a standalone child process', async () => {
    const proc = Bun.spawn(['bun', 'test', 'src/core/types/definition-schema-to-json.test.ts'], {
      cwd: import.meta.dir + '/../../..',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...Bun.env, FORCE_COLOR: '0' },
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      throw new Error(
        `Standalone Valibot adapter test failed (exit ${exitCode}).\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    expect(exitCode).toBe(0);
  }, 30_000);
});
