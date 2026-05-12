/**
 * `weft codegen` subcommand executor. Reads a registry snapshot from
 * either a live Weft server or a vendored JSON file, validates the
 * envelope, and emits a deterministic `.d.ts` augmenting the public
 * `'weft'` module.
 *
 * All user-caused failures (missing file, bad JSON, version mismatch,
 * HTTP errors, network timeout, missing parent directory, filesystem
 * errors) return a {@link CommandOutput} with `exitCode: 1` and a
 * single-line stderr diagnostic. Thrown errors are reserved for
 * programmer bugs.
 *
 * @module cli/codegen
 */

import { promises as fs } from 'node:fs';
import { basename, dirname } from 'node:path';

import { z } from 'zod';

import { REGISTRY_VERSION, type RegistrySnapshot } from '../core/registry-snapshot.ts';
import { emitRegistryDeclaration } from './codegen-emit.ts';
import type { CommandOutput } from './types.ts';

const workflowEntrySchema = z
  .object({
    inputSchema: z.unknown().optional(),
    outputSchema: z.unknown().optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .passthrough();

const activityEntrySchema = z
  .object({
    inputSchema: z.unknown().optional(),
    outputSchema: z.unknown().optional(),
    queue: z.string(),
    description: z.string().optional(),
  })
  .passthrough();

const registrySnapshotSchema = z
  .object({
    registryVersion: z.literal(REGISTRY_VERSION),
    workflows: z.record(z.string(), workflowEntrySchema),
    activities: z.record(z.string(), activityEntrySchema),
  })
  .passthrough();

/** Parsed options accepted by {@link executeCodegen}. */
export type CodegenOptions = {
  server?: string;
  from?: string;
  token?: string;
  out: string;
  timeoutMs: number;
};

/**
 * Run the codegen pipeline end-to-end. Returns a {@link CommandOutput}
 * describing the result. Never rejects for user-caused failures.
 */
export async function executeCodegen(options: CodegenOptions): Promise<CommandOutput> {
  const snapshotResult = await loadSnapshot(options);
  if (!snapshotResult.ok) {
    return { stdout: '', stderr: snapshotResult.error, exitCode: 1 };
  }

  const validation = validateSnapshot(snapshotResult.value);
  if (!validation.ok) {
    return { stdout: '', stderr: validation.error, exitCode: 1 };
  }

  const snapshot = validation.value;
  const content = emitRegistryDeclaration(snapshot);

  const writeResult = await writeOutput(options.out, content);
  if (!writeResult.ok) {
    return { stdout: '', stderr: writeResult.error, exitCode: 1 };
  }

  const workflowCount = Object.keys(snapshot.workflows).length;
  const activityCount = Object.keys(snapshot.activities).length;

  if (writeResult.action === 'unchanged') {
    return {
      stdout: `codegen: ${options.out} is up to date`,
      exitCode: 0,
    };
  }

  return {
    stdout: `codegen: wrote ${options.out} (${workflowCount} workflows, ${activityCount} activities)`,
    exitCode: 0,
  };
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function loadSnapshot(options: CodegenOptions): Promise<Result<unknown>> {
  if (options.from !== undefined) {
    return loadSnapshotFromFile(options.from);
  }
  if (options.server !== undefined) {
    return loadSnapshotFromServer(options.server, options.token, options.timeoutMs);
  }
  return { ok: false, error: 'codegen: exactly one of --server or --from must be provided' };
}

async function loadSnapshotFromFile(path: string): Promise<Result<unknown>> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { ok: false, error: `codegen: --from file not found at '${path}'` };
  }
  try {
    const value: unknown = await file.json();
    return { ok: true, value };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `codegen: failed to parse JSON at '${path}': ${message}` };
  }
}

/**
 * Compose the registry URL from a user-supplied base. Appends
 * `/v1/registry` to whatever path is present, so
 * `--server http://host/base` reaches `http://host/base/v1/registry`.
 * If the supplied URL already ends with `/v1/registry` (with or
 * without a trailing slash), the path is preserved as-is.
 */
export function composeRegistryUrl(serverUrl: string): URL {
  const url = new URL(serverUrl);
  const trimmedPath = url.pathname.replace(/\/+$/, '');
  if (trimmedPath.endsWith('/v1/registry')) {
    url.pathname = trimmedPath;
    return url;
  }
  url.pathname = `${trimmedPath}/v1/registry`;
  return url;
}

function buildRequestHeaders(explicitToken: string | undefined): Headers {
  const headers = new Headers({ Accept: 'application/json' });
  const token = explicitToken ?? Bun.env['WEFT_TOKEN'];
  if (token !== undefined && token !== '') {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return headers;
}

function describeFetchError(error: unknown, timeoutMs: number, resolvedUrl: URL): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return `codegen: timed out after ${timeoutMs}ms fetching ${resolvedUrl.toString()}`;
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return `codegen: request aborted after ${timeoutMs}ms fetching ${resolvedUrl.toString()}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `codegen: failed to fetch ${resolvedUrl.toString()}: ${message}`;
}

async function parseRegistryResponse(
  response: Response,
  resolvedUrl: URL,
): Promise<Result<unknown>> {
  if (!response.ok) {
    return {
      ok: false,
      error: `codegen: ${resolvedUrl.toString()} returned ${response.status} ${response.statusText}`,
    };
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!/\bjson\b/i.test(contentType)) {
    return {
      ok: false,
      error: `codegen: ${resolvedUrl.toString()} returned non-JSON content-type '${contentType}'`,
    };
  }

  try {
    const value: unknown = await response.json();
    return { ok: true, value };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `codegen: failed to parse response body from ${resolvedUrl.toString()}: ${message}`,
    };
  }
}

async function loadSnapshotFromServer(
  serverUrl: string,
  explicitToken: string | undefined,
  timeoutMs: number,
): Promise<Result<unknown>> {
  let resolvedUrl: URL;
  try {
    resolvedUrl = composeRegistryUrl(serverUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `codegen: invalid --server URL '${serverUrl}': ${message}` };
  }

  let response: Response;
  try {
    response = await fetch(resolvedUrl, {
      headers: buildRequestHeaders(explicitToken),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, error: describeFetchError(error, timeoutMs, resolvedUrl) };
  }

  return parseRegistryResponse(response, resolvedUrl);
}

function validateSnapshot(value: unknown): Result<RegistrySnapshot> {
  // Surface a clear version-mismatch diagnostic before delegating to
  // the full Zod schema, since the version check is the most likely
  // failure when consumers vendor a snapshot from an older or newer
  // server.
  if (
    value !== null &&
    typeof value === 'object' &&
    'registryVersion' in value &&
    (value as { registryVersion?: unknown }).registryVersion !== REGISTRY_VERSION
  ) {
    const actual = (value as { registryVersion?: unknown }).registryVersion;
    return {
      ok: false,
      error: `codegen: registryVersion ${String(actual)} is not supported (expected ${REGISTRY_VERSION}); upgrade or regenerate the snapshot`,
    };
  }

  const parsed = registrySnapshotSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error: `codegen: invalid registry snapshot: ${formatZodError(parsed.error)}`,
    };
  }
  return { ok: true, value: parsed.data as RegistrySnapshot };
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length === 0 ? '<root>' : issue.path.join('.');
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

type WriteResult = { ok: true; action: 'wrote' | 'unchanged' } | { ok: false; error: string };

async function writeOutput(outPath: string, content: string): Promise<WriteResult> {
  const parent = dirname(outPath);
  try {
    const stats = await fs.stat(parent);
    if (!stats.isDirectory()) {
      return { ok: false, error: `codegen: parent path '${parent}' is not a directory` };
    }
  } catch {
    return { ok: false, error: `codegen: parent directory '${parent}' does not exist` };
  }

  // Idempotent skip: if the existing file already matches byte-for-
  // byte, do not rewrite. Avoids touching mtime and satisfies the
  // "second run does not rewrite" acceptance bullet.
  try {
    const existing = await Bun.file(outPath).text();
    if (existing === content) {
      return { ok: true, action: 'unchanged' };
    }
  } catch {
    // File does not exist yet; fall through to the write path.
  }

  const tempPath = `${outPath}.codegen-${process.pid}-${randomSuffix()}.tmp`;
  try {
    await Bun.write(tempPath, content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `codegen: failed to write temp file '${basename(tempPath)}' in '${dirname(outPath)}': ${message}`,
    };
  }

  try {
    await fs.rename(tempPath, outPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await fs.unlink(tempPath).catch(() => {
      // Best-effort cleanup; surface the original rename error.
    });
    return {
      ok: false,
      error: `codegen: failed to rename '${basename(tempPath)}' to '${outPath}': ${message}`,
    };
  }

  return { ok: true, action: 'wrote' };
}

function randomSuffix(): string {
  // 12 hex chars are plenty to avoid collisions for a single CLI
  // invocation; `crypto.randomUUID` would work too but pulls in more
  // characters than we need.
  return Math.random().toString(16).slice(2, 14).padEnd(12, '0');
}
