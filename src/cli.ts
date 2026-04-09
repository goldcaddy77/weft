#!/usr/bin/env bun

/**
 * Weft CLI entry point.
 *
 * Starts the Weft durable execution engine with HTTP + WebSocket server
 * backed by a SQLite database.
 *
 * @module cli
 */

import { parseArgs } from 'node:util';

import type { Storage } from './storage/interface.ts';

// ---------------------------------------------------------------------------
// Subcommand types
// ---------------------------------------------------------------------------

/** Supported storage backend identifiers for the `--storage` flag. */
export type StorageBackend = 'sqlite' | 'lmdb' | 'memory';

export type CliCommand =
  | {
      command: 'serve';
      port: string;
      database: string;
      storage: StorageBackend;
      ui: boolean;
      help: boolean;
    }
  | { command: 'doctor'; database: string; help: boolean; json: boolean }
  | {
      command: 'version:check';
      database: string;
      workflows: string;
      help: boolean;
      json: boolean;
    }
  | { command: 'validate'; entryPath: string; help: boolean; json: boolean };

// ---------------------------------------------------------------------------
// Known subcommands
// ---------------------------------------------------------------------------

const KNOWN_SUBCOMMANDS = new Set(['doctor', 'version:check', 'validate']);

const VALID_STORAGE_BACKENDS = new Set<string>(['sqlite', 'lmdb', 'memory']);

// ---------------------------------------------------------------------------
// Argument parsing (exported for testing)
// ---------------------------------------------------------------------------

export function parseCliArguments(args: string[]): CliCommand {
  // Scan for the first non-flag value to determine the subcommand.
  let subcommand: string | undefined;
  let subcommandIndex = -1;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('-')) {
      // If this flag takes a value, skip the next arg too.
      if (
        arg === '-p' ||
        arg === '-d' ||
        arg === '-s' ||
        arg === '-w' ||
        arg === '--port' ||
        arg === '--database' ||
        arg === '--storage' ||
        arg === '--workflows'
      ) {
        i++;
      }
      continue;
    }
    // First non-flag argument found.
    if (arg && KNOWN_SUBCOMMANDS.has(arg)) {
      subcommand = arg;
      subcommandIndex = i;
    }
    break;
  }

  // Remove the subcommand token from args before passing to parseArgs.
  const remainingArgs =
    subcommandIndex >= 0
      ? [...args.slice(0, subcommandIndex), ...args.slice(subcommandIndex + 1)]
      : args;

  if (subcommand === 'doctor') {
    return parseDoctorArguments(remainingArgs);
  }

  if (subcommand === 'version:check') {
    return parseVersionCheckArguments(remainingArgs);
  }

  if (subcommand === 'validate') {
    return parseValidateArguments(remainingArgs);
  }

  return parseServeArguments(remainingArgs);
}

/** Validates that a string is a known storage backend identifier. */
function isValidStorageBackend(value: string): value is StorageBackend {
  return VALID_STORAGE_BACKENDS.has(value);
}

function parseServeArguments(args: string[]): CliCommand {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string', short: 'p', default: '7233' },
      database: { type: 'string', short: 'd', default: './weft.db' },
      storage: { type: 'string', short: 's', default: 'sqlite' },
      ui: { type: 'boolean', default: true },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: true,
    allowNegative: true,
  });

  const storageValue = values.storage ?? 'sqlite';

  if (!isValidStorageBackend(storageValue)) {
    throw new Error(
      `Invalid storage backend '${storageValue}'. Must be one of: sqlite, lmdb, memory`,
    );
  }

  return {
    command: 'serve',
    port: values.port ?? '7233',
    database: values.database ?? './weft.db',
    storage: storageValue,
    ui: values.ui ?? true,
    help: values.help ?? false,
  };
}

function parseDoctorArguments(args: string[]): CliCommand {
  const { values } = parseArgs({
    args,
    options: {
      database: { type: 'string', short: 'd', default: './weft.db' },
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  return {
    command: 'doctor',
    database: values.database ?? './weft.db',
    help: values.help ?? false,
    json: values.json ?? false,
  };
}

function parseVersionCheckArguments(args: string[]): CliCommand {
  const { values } = parseArgs({
    args,
    options: {
      database: { type: 'string', short: 'd', default: './weft.db' },
      workflows: { type: 'string', short: 'w', default: '' },
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  return {
    command: 'version:check',
    database: values.database ?? './weft.db',
    workflows: values.workflows ?? '',
    help: values.help ?? false,
    json: values.json ?? false,
  };
}

function parseValidateArguments(args: string[]): CliCommand {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  return {
    command: 'validate',
    entryPath: positionals[0] ?? '',
    help: values.help ?? false,
    json: values.json ?? false,
  };
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

export const HELP_TEXT = `
weft - Bun-native durable execution engine

Usage: weft [command] [options]

Commands:
  serve           Start the Weft server (default)
  doctor          Run diagnostics on the Weft database
  version:check   Check workflow version compatibility
  validate        Lint workflow registrations for design-time anti-patterns

Serve Options:
  -p, --port <port>           Server port (default: 7233)
  -d, --database <path>       Database file path (default: ./weft.db)
  -s, --storage <backend>     Storage backend: sqlite, lmdb, memory (default: sqlite)
      --no-ui                 Disable the dashboard UI
  -h, --help                  Show this help message
`;

export const DOCTOR_HELP_TEXT = `
weft doctor - Run diagnostics on the Weft database

Usage: weft doctor [options]

Options:
  -d, --database <path>   Database file path (default: ./weft.db)
  -j, --json              Output results as JSON
  -h, --help              Show this help message
`;

export const VERSION_CHECK_HELP_TEXT = `
weft version:check - Check workflow version compatibility

Usage: weft version:check [options]

Options:
  -d, --database <path>     Database file path (default: ./weft.db)
  -w, --workflows <path>    Path to workflows module
  -j, --json                Output results as JSON
  -h, --help                Show this help message
`;

export const VALIDATE_HELP_TEXT = `
weft validate - Lint workflow registrations for design-time anti-patterns

Usage: weft validate <entry.ts> [options]

Arguments:
  <entry.ts>              Path to a TypeScript module that exports workflow
                          registrations and/or activity definitions.

Options:
  -j, --json              Output results as JSON
  -h, --help              Show this help message

Exit codes:
  0   No errors (warnings may be present)
  1   One or more errors detected
  2   Entry file could not be loaded

Checks performed:
  unbounded-retry               Activity retry.maxAttempts is Infinity
  stateful-without-compensator  Non-idempotent activity has no compensate fn
`;

// ---------------------------------------------------------------------------
// Command execution (exported for testing)
// ---------------------------------------------------------------------------

export interface CommandOutput {
  stdout: string;
  exitCode: number;
  stderr?: string;
}

export async function executeDoctor(options: {
  database: string;
  json: boolean;
}): Promise<CommandOutput> {
  const { collectDiagnostics } = await import('./diagnostics/doctor.ts');
  const { formatDiagnosticReport } = await import('./diagnostics/format.ts');
  const { BunSQLiteStorage } = await import('./storage/bun-sql.ts');

  const storage = new BunSQLiteStorage(options.database);

  try {
    const report = await collectDiagnostics(storage, options.database);
    const stdout = options.json ? JSON.stringify(report, null, 2) : formatDiagnosticReport(report);
    return { stdout, exitCode: 0 };
  } finally {
    storage[Symbol.dispose]();
  }
}

export async function executeVersionCheck(options: {
  database: string;
  workflows: string;
  json: boolean;
}): Promise<CommandOutput> {
  if (!options.workflows) {
    return {
      stdout: '',
      stderr: 'Error: --workflows flag is required for version:check',
      exitCode: 1,
    };
  }

  const { runVersionCheck } = await import('./diagnostics/version-check.ts');
  const { formatVersionCheckReport } = await import('./diagnostics/format.ts');
  const { BunSQLiteStorage } = await import('./storage/bun-sql.ts');

  const storage = new BunSQLiteStorage(options.database);

  try {
    const registrations = await import(options.workflows);
    const report = await runVersionCheck(storage, registrations.default);
    const stdout = options.json
      ? JSON.stringify(report, null, 2)
      : formatVersionCheckReport(report);
    return { stdout, exitCode: 0 };
  } finally {
    storage[Symbol.dispose]();
  }
}

export async function executeValidate(options: {
  entryPath: string;
  json: boolean;
}): Promise<CommandOutput> {
  if (!options.entryPath) {
    return {
      stdout: '',
      stderr: 'Error: entry file path is required for validate',
      exitCode: 1,
    };
  }

  const { loadRegistrationsFromModule, validateRegistrations, formatValidationReport } =
    await import('./diagnostics/validate.ts');

  let registrations: Record<string, import('./core/types.ts').WorkflowRegistration>;
  let activities: import('./core/types.ts').ActivityDefinition[];

  try {
    const loaded = await loadRegistrationsFromModule(options.entryPath);
    registrations = loaded.registrations;
    activities = loaded.activities;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      stdout: '',
      stderr: `Error: could not load entry file '${options.entryPath}': ${message}`,
      exitCode: 2,
    };
  }

  const report = validateRegistrations(registrations, activities);

  const stdout = options.json
    ? JSON.stringify(report, null, 2)
    : formatValidationReport(report, options.entryPath);

  return { stdout, exitCode: report.valid ? 0 : 1 };
}

// ---------------------------------------------------------------------------
// Storage factory (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Creates a storage instance based on the selected backend and database path.
 *
 * Uses dynamic imports so that native addons (LMDB) are only loaded when
 * actually requested — this avoids errors in compiled binaries where the
 * native binding may not be bundled.
 */
async function createMemoryStorage(): Promise<Storage> {
  const { MemoryStorage } = await import('./storage/memory.ts');
  return new MemoryStorage();
}

export async function createStorage(backend: StorageBackend, database: string): Promise<Storage> {
  switch (backend) {
    case 'sqlite': {
      const { BunSQLiteStorage } = await import('./storage/bun-sql.ts');
      return new BunSQLiteStorage(database);
    }
    case 'lmdb': {
      const { LMDBStorage } = await import('./storage/lmdb.ts');
      return new LMDBStorage(database);
    }
    case 'memory':
      return createMemoryStorage();
  }
}
