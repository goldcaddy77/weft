const DEFAULT_READY_PATTERN = /(?:WEFT_SUBPROCESS_READY|Weft running on)\s+(\S+)/;
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_EXIT_TIMEOUT_MS = 2_000;
const MAX_CAPTURED_OUTPUT_LENGTH = 32_768;

type RunningSubprocess = Bun.Subprocess<'ignore', 'pipe', 'pipe'>;

/**
 * Configuration for starting a Weft server in a child Bun process.
 *
 * Use this for process-level durability tests that need a real server, a real
 * wire protocol, and an on-disk storage path that survives process death.
 *
 * @example
 * ```ts
 * import type { SubprocessServerOptions } from 'weft/testing';
 *
 * const options: SubprocessServerOptions = {
 *   entrypoint: './tmp/durability-entrypoint.ts',
 *   databasePath: './tmp/weft-durability.db',
 * };
 * void options;
 * ```
 */
export interface SubprocessServerOptions {
  entrypoint: string;
  databasePath: string;
  port?: number;
  hostname?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  args?: readonly string[];
  readyPattern?: RegExp;
  startupTimeoutMs?: number;
  exitTimeoutMs?: number;
}

interface NormalizedSubprocessServerOptions {
  entrypoint: string;
  databasePath: string;
  port: number;
  hostname?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  args: readonly string[];
  readyPattern: RegExp;
  startupTimeoutMs: number;
  exitTimeoutMs: number;
}

/**
 * Handle for a running Weft server subprocess started by
 * {@link spawnServerSubprocess}.
 *
 * The handle exposes the discovered server URL, the concrete command, bounded
 * stdout and stderr capture, and a stop helper for cleanup in test teardown.
 *
 * @example
 * ```ts
 * import { spawnServerSubprocess, type SubprocessServerHandle } from 'weft/testing';
 *
 * const server: SubprocessServerHandle = await spawnServerSubprocess({
 *   entrypoint: './tmp/durability-entrypoint.ts',
 *   databasePath: './tmp/weft-durability.db',
 * });
 * await server.stop();
 * ```
 */
export interface SubprocessServerHandle extends AsyncDisposable {
  readonly process: RunningSubprocess;
  readonly url: string;
  readonly port: number;
  readonly databasePath: string;
  readonly command: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  stop(signal?: NodeJS.Signals): Promise<void>;
}

class SubprocessServerHandleImpl implements SubprocessServerHandle {
  readonly process: RunningSubprocess;
  readonly url: string;
  readonly port: number;
  readonly databasePath: string;
  readonly command: readonly string[];
  readonly #options: NormalizedSubprocessServerOptions;
  readonly #output: CapturedOutput;

  constructor(
    process: RunningSubprocess,
    url: string,
    command: readonly string[],
    options: NormalizedSubprocessServerOptions,
    output: CapturedOutput,
  ) {
    this.process = process;
    this.url = url;
    this.port = new URL(url).port === '' ? 80 : Number(new URL(url).port);
    this.databasePath = options.databasePath;
    this.command = command;
    this.#options = { ...options, port: this.port };
    this.#output = output;
  }

  get stdout(): string {
    return this.#output.stdout;
  }

  get stderr(): string {
    return this.#output.stderr;
  }

  get restartOptions(): NormalizedSubprocessServerOptions {
    return this.#options;
  }

  async stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    await stopProcess(this.process, signal, this.#options.exitTimeoutMs);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }
}

type CapturedOutput = {
  stdout: string;
  stderr: string;
};

function appendCapturedOutput(current: string, chunk: string): string {
  const next = current + chunk;
  if (next.length <= MAX_CAPTURED_OUTPUT_LENGTH) return next;
  return next.slice(next.length - MAX_CAPTURED_OUTPUT_LENGTH);
}

function normalizeOptions(options: SubprocessServerOptions): NormalizedSubprocessServerOptions {
  return {
    entrypoint: options.entrypoint,
    databasePath: options.databasePath,
    port: options.port ?? 0,
    ...(options.hostname !== undefined ? { hostname: options.hostname } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    args: options.args ?? [],
    readyPattern: options.readyPattern ?? DEFAULT_READY_PATTERN,
    startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    exitTimeoutMs: options.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS,
  };
}

function buildCommand(options: NormalizedSubprocessServerOptions): string[] {
  const command = [
    process.execPath,
    options.entrypoint,
    '--port',
    String(options.port),
    '--database',
    options.databasePath,
  ];
  if (options.hostname !== undefined) {
    command.push('--hostname', options.hostname);
  }
  command.push(...options.args);
  return command;
}

function setEnvironmentIfDefined(
  environment: Record<string, string>,
  key: string,
  value: string | undefined,
): void {
  if (value !== undefined) environment[key] = value;
}

function createSubprocessEnvironment(
  explicitEnvironment: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const environment: Record<string, string> = {};
  setEnvironmentIfDefined(environment, 'PATH', Bun.env['PATH']);
  setEnvironmentIfDefined(environment, 'HOME', Bun.env['HOME']);
  setEnvironmentIfDefined(environment, 'TMPDIR', Bun.env['TMPDIR']);
  setEnvironmentIfDefined(environment, 'TEMP', Bun.env['TEMP']);
  setEnvironmentIfDefined(environment, 'TMP', Bun.env['TMP']);
  setEnvironmentIfDefined(environment, 'TZ', Bun.env['TZ']);
  setEnvironmentIfDefined(environment, 'NODE_ENV', Bun.env['NODE_ENV']);

  for (const [key, value] of Object.entries(explicitEnvironment ?? {})) {
    if (value !== undefined) environment[key] = value;
  }

  return environment;
}

function createReadyWatcher(
  process: RunningSubprocess,
  output: CapturedOutput,
  readyPattern: RegExp,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `Timed out after ${timeoutMs}ms waiting for subprocess readiness.\n${formatOutput(output)}`,
        ),
      );
    }, timeoutMs);

    function settleWithUrl(url: string): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(url);
    }

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    }

    void process.exited.then((exitCode) => {
      fail(
        new Error(
          `Subprocess exited with code ${exitCode} before readiness.\n${formatOutput(output)}`,
        ),
      );
      return undefined;
    });

    void drainStream(process.stdout, (chunk) => {
      output.stdout = appendCapturedOutput(output.stdout, chunk);
      const match = output.stdout.match(readyPattern);
      const url = match?.[1];
      if (url !== undefined) settleWithUrl(url);
    }).catch((error: unknown) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });

    void drainStream(process.stderr, (chunk) => {
      output.stderr = appendCapturedOutput(output.stderr, chunk);
    });
  });
}

async function drainStream(
  stream: ReadableStream<Uint8Array> | null,
  onChunk: (chunk: string) => void,
): Promise<void> {
  if (stream === null) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      onChunk(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
}

function formatOutput(output: CapturedOutput): string {
  return [`stdout:\n${output.stdout || '<empty>'}`, `stderr:\n${output.stderr || '<empty>'}`].join(
    '\n',
  );
}

async function waitForExit(
  process: RunningSubprocess,
  timeoutMs: number,
  label: string,
): Promise<number> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      process.exited,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function stopProcess(
  process: RunningSubprocess,
  signal: NodeJS.Signals,
  timeoutMs: number,
): Promise<void> {
  if (process.exitCode !== null) return;
  process.kill(signal);
  try {
    await waitForExit(process, timeoutMs, 'subprocess exit');
  } catch {
    if (process.exitCode === null) {
      process.kill('SIGKILL');
      await process.exited.catch(() => undefined);
    }
  }
}

function expectedExitCodeForSignal(signal: NodeJS.Signals): number | undefined {
  if (signal === 'SIGKILL') return 137;
  if (signal === 'SIGTERM') return 143;
  if (signal === 'SIGINT') return 130;
  return undefined;
}

/**
 * Starts a Weft server entrypoint in a real Bun subprocess and waits for the
 * server to print a readiness URL.
 *
 * The child process receives only a small runtime environment by default plus
 * any explicit `env` values. Failures include the captured child stdout and
 * stderr so startup crashes do not become hung tests.
 *
 * @example
 * ```ts
 * import { spawnServerSubprocess } from 'weft/testing';
 *
 * const server = await spawnServerSubprocess({
 *   entrypoint: './tmp/durability-entrypoint.ts',
 *   databasePath: './tmp/weft-durability.db',
 * });
 * await server.stop();
 * ```
 */
export async function spawnServerSubprocess(
  options: SubprocessServerOptions,
): Promise<SubprocessServerHandle> {
  const normalizedOptions = normalizeOptions(options);
  const command = buildCommand(normalizedOptions);
  const output: CapturedOutput = { stdout: '', stderr: '' };
  const spawnOptions: Bun.SpawnOptions.OptionsObject<'ignore', 'pipe', 'pipe'> & {
    cmd: string[];
  } = {
    cmd: command,
    env: createSubprocessEnvironment(normalizedOptions.env),
    stdout: 'pipe',
    stderr: 'pipe',
  };
  if (normalizedOptions.cwd !== undefined) {
    spawnOptions.cwd = normalizedOptions.cwd;
  }
  const process = Bun.spawn(spawnOptions);

  try {
    const url = await createReadyWatcher(
      process,
      output,
      normalizedOptions.readyPattern,
      normalizedOptions.startupTimeoutMs,
    );
    return new SubprocessServerHandleImpl(process, url, command, normalizedOptions, output);
  } catch (error) {
    await stopProcess(process, 'SIGKILL', normalizedOptions.exitTimeoutMs);
    throw error;
  }
}

/**
 * Kills a running server subprocess and starts a replacement against the same
 * database path, port, entrypoint, and environment.
 *
 * The default signal is `SIGKILL` so tests exercise ungraceful process death.
 * If the original process exits for the wrong reason, the helper rejects with
 * captured stdout and stderr instead of silently rebooting.
 *
 * @example
 * ```ts
 * import { killAndReboot, spawnServerSubprocess } from 'weft/testing';
 *
 * const server = await spawnServerSubprocess({
 *   entrypoint: './tmp/durability-entrypoint.ts',
 *   databasePath: './tmp/weft-durability.db',
 * });
 * const rebooted = await killAndReboot(server);
 * await rebooted.stop();
 * ```
 */
export async function killAndReboot(
  handle: SubprocessServerHandle,
  signal: NodeJS.Signals = 'SIGKILL',
): Promise<SubprocessServerHandle> {
  if (!(handle instanceof SubprocessServerHandleImpl)) {
    throw new Error('killAndReboot requires a handle returned by spawnServerSubprocess');
  }
  if (handle.process.exitCode !== null) {
    throw new Error(`Cannot reboot: subprocess already exited.\n${formatOutput(handle)}`);
  }

  handle.process.kill(signal);
  const exitCode = await waitForExit(handle.process, handle.restartOptions.exitTimeoutMs, 'kill');
  const expectedExitCode = expectedExitCodeForSignal(signal);
  if (expectedExitCode !== undefined && exitCode !== expectedExitCode) {
    throw new Error(
      `Expected subprocess to exit from ${signal} with code ${expectedExitCode}, got ${exitCode}.\n${formatOutput(handle)}`,
    );
  }

  return spawnServerSubprocess(handle.restartOptions);
}

/**
 * Runs a callback with a server subprocess and tears it down after the callback
 * settles.
 *
 * Use this helper for tests that only need one process lifetime. Tests that
 * intentionally kill and reboot should manage the returned handle explicitly
 * with {@link spawnServerSubprocess} and {@link killAndReboot}.
 *
 * @example
 * ```ts
 * import { withSubprocessServer } from 'weft/testing';
 *
 * await withSubprocessServer(
 *   {
 *     entrypoint: './tmp/durability-entrypoint.ts',
 *     databasePath: './tmp/weft-durability.db',
 *   },
 *   async (server) => {
 *     const response = await fetch(`${server.url}/v1/health`);
 *     await response.text();
 *   },
 * );
 * ```
 */
export async function withSubprocessServer<T>(
  options: SubprocessServerOptions,
  callback: (handle: SubprocessServerHandle) => Promise<T>,
): Promise<T> {
  const handle = await spawnServerSubprocess(options);
  try {
    return await callback(handle);
  } finally {
    await handle.stop();
  }
}
