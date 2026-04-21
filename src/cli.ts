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

import { isRecord, safeDebugStringify } from './core/debug-output.ts';
import type { Engine } from './core/engine.ts';
import type {
  ActivityDefinition,
  ScheduleOverlapPolicy,
  WorkflowRegistration,
} from './core/types.ts';
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
  | { command: 'validate'; entryPath: string; help: boolean; json: boolean }
  | {
      command: 'timeline';
      database: string;
      workflowId: string;
      step?: number;
      diff?: [number, number];
      help: boolean;
    }
  | {
      command: 'schedule';
      action: 'list';
      database: string;
      storage: StorageBackend;
      help: boolean;
      json: boolean;
    }
  | {
      command: 'schedule';
      action: 'create';
      database: string;
      storage: StorageBackend;
      workflows: string;
      workflowType: string;
      cronExpression: string;
      input: string;
      id?: string;
      overlap?: 'skip' | 'queue' | 'cancel-running' | 'allow';
      backfill: boolean;
      help: boolean;
      json: boolean;
    }
  | {
      command: 'schedule';
      action: 'pause' | 'resume' | 'cancel';
      database: string;
      storage: StorageBackend;
      scheduleId: string;
      help: boolean;
      json: boolean;
    };

type ScheduleCommand = Extract<CliCommand, { command: 'schedule' }>;
type ScheduleAction = ScheduleCommand['action'];
type ScheduleListCommand = Extract<ScheduleCommand, { action: 'list' }>;
type ScheduleCreateCommand = Extract<ScheduleCommand, { action: 'create' }>;
type ScheduleMutationCommand = Extract<ScheduleCommand, { action: 'pause' | 'resume' | 'cancel' }>;

// ---------------------------------------------------------------------------
// Known subcommands
// ---------------------------------------------------------------------------

const KNOWN_SUBCOMMANDS = new Set(['doctor', 'version:check', 'validate', 'timeline', 'schedule']);

const VALID_STORAGE_BACKENDS = new Set<string>(['sqlite', 'lmdb', 'memory']);
const SCHEDULE_ACTIONS = new Set<ScheduleAction>(['list', 'create', 'pause', 'resume', 'cancel']);
const VALID_SCHEDULE_OVERLAP_POLICIES = new Set<ScheduleOverlapPolicy>([
  'skip',
  'queue',
  'cancel-running',
  'allow',
]);

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

  if (subcommand === 'timeline') {
    return parseTimelineArguments(remainingArgs);
  }

  if (subcommand === 'schedule') {
    return parseScheduleArguments(remainingArgs);
  }

  return parseServeArguments(remainingArgs);
}

/** Validates that a string is a known storage backend identifier. */
function isValidStorageBackend(value: string): value is StorageBackend {
  return VALID_STORAGE_BACKENDS.has(value);
}

function parseStorageBackend(value: string | undefined): StorageBackend {
  const storageValue = value ?? 'sqlite';

  if (!isValidStorageBackend(storageValue)) {
    throw new Error(
      `Invalid storage backend '${storageValue}'. Must be one of: sqlite, lmdb, memory`,
    );
  }

  return storageValue;
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

  return {
    command: 'serve',
    port: values.port ?? '7233',
    database: values.database ?? './weft.db',
    storage: parseStorageBackend(values.storage),
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

function parseTimelineStep(value: string, flagName: string): number {
  const step = Number(value);
  if (!Number.isSafeInteger(step) || step < 0) {
    throw new Error(`${flagName} must be a non-negative integer`);
  }
  return step;
}

function parseTimelineArguments(args: string[]): CliCommand {
  const { values, positionals } = parseArgs({
    args,
    options: {
      database: { type: 'string', short: 'd', default: './weft.db' },
      step: { type: 'string' },
      diff: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const workflowId = positionals[0] ?? '';
  const step = values.step !== undefined ? parseTimelineStep(values.step, '--step') : undefined;

  let diff: [number, number] | undefined;
  if (values.diff) {
    if (positionals[1] === undefined || positionals[2] === undefined) {
      throw new Error('--diff requires two step numbers');
    }
    diff = [
      parseTimelineStep(positionals[1], '--diff'),
      parseTimelineStep(positionals[2], '--diff'),
    ];
  }

  if (step !== undefined && diff !== undefined) {
    throw new Error('--step and --diff cannot be used together');
  }

  return {
    command: 'timeline',
    database: values.database ?? './weft.db',
    workflowId,
    ...(step !== undefined ? { step } : {}),
    ...(diff !== undefined ? { diff } : {}),
    help: values.help ?? false,
  };
}

function parseScheduleCliValues(args: string[]) {
  return parseArgs({
    args,
    options: {
      database: { type: 'string', short: 'd', default: './weft.db' },
      storage: { type: 'string', short: 's', default: 'sqlite' },
      workflows: { type: 'string', short: 'w', default: '' },
      input: { type: 'string', default: 'null' },
      id: { type: 'string' },
      overlap: { type: 'string' },
      backfill: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
    },
    strict: true,
    allowPositionals: true,
  });
}

function parseScheduleOverlapPolicy(value: string | undefined): ScheduleOverlapPolicy | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!VALID_SCHEDULE_OVERLAP_POLICIES.has(value as ScheduleOverlapPolicy)) {
    throw new Error(
      `Invalid overlap policy '${value}'. Must be one of: skip, queue, cancel-running, allow`,
    );
  }

  return value as ScheduleOverlapPolicy;
}

function buildScheduleListCommand(
  values: ReturnType<typeof parseScheduleCliValues>['values'],
): ScheduleListCommand {
  return {
    command: 'schedule',
    action: 'list',
    database: values.database ?? './weft.db',
    storage: parseStorageBackend(values.storage),
    help: values.help ?? false,
    json: values.json ?? false,
  };
}

function formatScheduleActionList(): string {
  return [...SCHEDULE_ACTIONS].join(', ');
}

function rejectUnexpectedSchedulePositionals(
  action: string,
  positionals: string[],
  usage: string,
): void {
  if (positionals.length <= 1) {
    return;
  }

  throw new Error(`schedule ${action} expects exactly 1 positional argument: ${usage}`);
}

function requireScheduleAction(positionals: string[]): ScheduleAction {
  const action = positionals[0];
  if (action === undefined) {
    throw new Error(`Missing schedule action. Expected one of: ${formatScheduleActionList()}`);
  }

  if (!SCHEDULE_ACTIONS.has(action as ScheduleAction)) {
    throw new Error(
      `Unknown schedule action "${action}". Expected one of: ${formatScheduleActionList()}`,
    );
  }

  return action as ScheduleAction;
}

function buildScheduleCreateCommand(
  values: ReturnType<typeof parseScheduleCliValues>['values'],
  positionals: string[],
): ScheduleCreateCommand {
  const overlap = parseScheduleOverlapPolicy(values.overlap);

  return {
    command: 'schedule',
    action: 'create',
    database: values.database ?? './weft.db',
    storage: parseStorageBackend(values.storage),
    workflows: values.workflows ?? '',
    workflowType: positionals[0] ?? '',
    cronExpression: positionals[1] ?? '',
    input: values.input ?? 'null',
    ...(values.id !== undefined ? { id: values.id } : {}),
    ...(overlap !== undefined ? { overlap } : {}),
    backfill: values.backfill ?? false,
    help: values.help ?? false,
    json: values.json ?? false,
  };
}

function buildScheduleMutationCommand(
  action: ScheduleMutationCommand['action'],
  values: ReturnType<typeof parseScheduleCliValues>['values'],
  positionals: string[],
): ScheduleMutationCommand {
  return {
    command: 'schedule',
    action,
    database: values.database ?? './weft.db',
    storage: parseStorageBackend(values.storage),
    scheduleId: positionals[0] ?? '',
    help: values.help ?? false,
    json: values.json ?? false,
  };
}

function parseScheduleArguments(args: string[]): CliCommand {
  const { values, positionals } = parseScheduleCliValues(args);
  if (values.help) {
    return buildScheduleListCommand(values);
  }

  const action = requireScheduleAction(positionals);
  const actionPositionals = positionals.slice(1);

  if (action === 'create') {
    if (actionPositionals.length > 2) {
      throw new Error(
        'schedule create expects exactly 2 positional arguments: <workflowType> <cronExpression>',
      );
    }
    return buildScheduleCreateCommand(values, actionPositionals);
  }

  if (action === 'pause' || action === 'resume' || action === 'cancel') {
    rejectUnexpectedSchedulePositionals(action, actionPositionals, '<scheduleId>');
    return buildScheduleMutationCommand(action, values, actionPositionals);
  }

  if (actionPositionals.length > 0) {
    throw new Error('schedule list does not accept positional arguments');
  }

  return buildScheduleListCommand(values);
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
  schedule        Manage recurring schedules
  timeline        Inspect workflow timeline and replay history
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

export const TIMELINE_HELP_TEXT = `
weft timeline - Inspect workflow timeline and replay history

Usage:
  weft timeline <workflowId> [options]
  weft timeline <workflowId> --diff <fromStep> <toStep> [options]

Options:
  -d, --database <path>     Database file path (default: ./weft.db)
      --step <step>         Show replay details for one checkpoint step
      --diff                Diff two checkpoint steps (requires two positional step numbers)
  -h, --help                Show this help message
`;

export const SCHEDULE_HELP_TEXT = `
weft schedule - Manage recurring schedules

Usage:
  weft schedule list [options]
  weft schedule create <workflowType> <cronExpression> [options]
  weft schedule pause <scheduleId> [options]
  weft schedule resume <scheduleId> [options]
  weft schedule cancel <scheduleId> [options]

Options:
  -d, --database <path>     Database file path (default: ./weft.db)
  -s, --storage <backend>   Storage backend: sqlite, lmdb, memory (default: sqlite)
  -w, --workflows <path>    Path to workflow registrations module (required for create)
      --input <json>        JSON input payload for create (default: null)
      --id <id>             Custom schedule id for create
      --overlap <policy>    Overlap policy: skip, queue, cancel-running, allow
      --backfill            Run missed ticks on recovery
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
      exitCode: 2,
    };
  }

  const { loadRegistrationsFromModule, validateRegistrations, formatValidationReport } =
    await import('./diagnostics/validate.ts');

  let registrations: Record<string, WorkflowRegistration>;
  let activities: ActivityDefinition[];

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

function formatTimelineLine(entry: {
  step: number;
  operationType: string;
  operationLabel: string;
  status: string;
  duration?: number;
  outputSummary?: string;
}): string {
  const duration = entry.duration !== undefined ? `${entry.duration}ms` : '-';
  const output = entry.outputSummary ?? '(pending)';
  return `Step ${entry.step} | ${entry.operationType} | ${entry.operationLabel} | ${entry.status} | ${duration} | ${output}`;
}

function formatValue(value: unknown): string {
  return safeDebugStringify(value, 2);
}

function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function collectDiffLines(
  beforeValue: unknown,
  afterValue: unknown,
  path: string,
  lines: string[],
): void {
  if (Object.is(beforeValue, afterValue)) {
    return;
  }

  if (Array.isArray(beforeValue) && Array.isArray(afterValue)) {
    const length = Math.max(beforeValue.length, afterValue.length);
    for (let index = 0; index < length; index++) {
      collectDiffLines(beforeValue[index], afterValue[index], `${path}[${index}]`, lines);
    }
    return;
  }

  if (isPlainObjectRecord(beforeValue) && isPlainObjectRecord(afterValue)) {
    const keys = new Set([...Object.keys(beforeValue), ...Object.keys(afterValue)]);
    for (const key of [...keys].toSorted()) {
      const childPath = path ? `${path}.${key}` : key;
      collectDiffLines(beforeValue[key], afterValue[key], childPath, lines);
    }
    return;
  }

  lines.push(`${path}: ${formatValue(beforeValue)} -> ${formatValue(afterValue)}`);
}

export async function executeTimeline(options: {
  database: string;
  workflowId: string;
  step?: number;
  diff?: [number, number];
}): Promise<CommandOutput> {
  if (!options.workflowId) {
    return {
      stdout: '',
      stderr: 'Error: workflowId is required for timeline',
      exitCode: 1,
    };
  }

  const { BunSQLiteStorage } = await import('./storage/bun-sql.ts');
  const storage = new BunSQLiteStorage(options.database);
  const { Engine } = await import('./core/engine.ts');
  const engine = new Engine({ storage });

  try {
    const state = await engine.get(options.workflowId);
    if (state === null) {
      return {
        stdout: '',
        stderr: `Error: workflow "${options.workflowId}" not found`,
        exitCode: 1,
      };
    }

    if (options.step !== undefined) {
      const replay = await engine.replayTo(options.workflowId, options.step);
      if (replay === null) {
        return {
          stdout: '',
          stderr: `Error: replay not found for step ${options.step}`,
          exitCode: 1,
        };
      }

      return {
        stdout: [
          `Replay step ${options.step} for ${options.workflowId}`,
          '',
          `Checkpoint: ${formatValue(replay.checkpoint)}`,
          '',
          `Accumulated results: ${formatValue(replay.accumulatedResults)}`,
          '',
          `Events: ${formatValue(replay.events)}`,
        ].join('\n'),
        exitCode: 0,
      };
    }

    if (options.diff !== undefined) {
      const [fromStep, toStep] = options.diff;
      const fromReplay = await engine.replayTo(options.workflowId, fromStep);
      const toReplay = await engine.replayTo(options.workflowId, toStep);
      if (fromReplay === null || toReplay === null) {
        return {
          stdout: '',
          stderr: `Error: replay not found for diff ${fromStep} -> ${toStep}`,
          exitCode: 1,
        };
      }

      const lines: string[] = [];
      collectDiffLines(fromReplay.checkpoint, toReplay.checkpoint, 'checkpoint', lines);
      collectDiffLines(
        fromReplay.accumulatedResults,
        toReplay.accumulatedResults,
        'accumulatedResults',
        lines,
      );

      return {
        stdout: [`Diff ${fromStep} -> ${toStep} for ${options.workflowId}`, ...lines].join('\n'),
        exitCode: 0,
      };
    }

    const timeline = await engine.getTimeline(options.workflowId);
    return {
      stdout:
        timeline.length === 0
          ? `No timeline entries found for workflow "${options.workflowId}".`
          : timeline.map(formatTimelineLine).join('\n'),
      exitCode: 0,
    };
  } finally {
    await engine[Symbol.asyncDispose]();
    storage[Symbol.dispose]();
  }
}

function formatScheduleLine(schedule: {
  id: string;
  workflowType: string;
  cronExpression: string;
  status: string;
  nextFireAt: number | null;
}): string {
  return [
    schedule.id,
    schedule.workflowType,
    schedule.status,
    schedule.cronExpression,
    schedule.nextFireAt === null ? 'none' : new Date(schedule.nextFireAt).toISOString(),
  ].join(' | ');
}

function formatScheduleCommandOutput(schedule: unknown, json: boolean, message: string): string {
  return json ? JSON.stringify(schedule, null, 2) : message;
}

async function executeScheduleList(
  options: ScheduleListCommand,
  engine: Engine,
): Promise<CommandOutput> {
  const result = await engine.listSchedules();
  const stdout = options.json
    ? JSON.stringify(result, null, 2)
    : result.items.length === 0
      ? 'No schedules found.'
      : [
          'ID | Workflow Type | Status | Cron | Next Fire',
          ...result.items.map(formatScheduleLine),
        ].join('\n');

  return { stdout, exitCode: 0 };
}

function getScheduleCreateValidationError(options: ScheduleCreateCommand): string | null {
  if (!options.workflows) {
    return 'Error: --workflows flag is required for schedule create';
  }

  if (!options.workflowType) {
    return 'Error: missing required argument <workflowType> for schedule create';
  }

  if (!options.cronExpression) {
    return 'Error: missing required argument <cronExpression> for schedule create';
  }

  return null;
}

function parseScheduleInput(
  input: string,
): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Error: could not parse --input JSON: ${message}` };
  }
}

async function registerScheduleWorkflows(
  engine: Engine,
  workflowsPath: string,
  loadRegistrationsFromModule: (modulePath: string) => Promise<{
    registrations: Record<string, WorkflowRegistration>;
  }>,
): Promise<void> {
  const loaded = await loadRegistrationsFromModule(workflowsPath);
  for (const [workflowType, registration] of Object.entries(loaded.registrations)) {
    engine.register(workflowType, registration);
  }
}

async function executeScheduleCreate(
  options: ScheduleCreateCommand,
  engine: Engine,
  loadRegistrationsFromModule: (modulePath: string) => Promise<{
    registrations: Record<string, WorkflowRegistration>;
  }>,
): Promise<CommandOutput> {
  const validationError = getScheduleCreateValidationError(options);
  if (validationError !== null) {
    return { stdout: '', stderr: validationError, exitCode: 1 };
  }

  await registerScheduleWorkflows(engine, options.workflows, loadRegistrationsFromModule);

  const parsedInput = parseScheduleInput(options.input);
  if (!parsedInput.ok) {
    return { stdout: '', stderr: parsedInput.message, exitCode: 1 };
  }

  const handle = await engine.schedule(
    options.workflowType,
    parsedInput.value,
    options.cronExpression,
    {
      ...(options.id !== undefined ? { id: options.id } : {}),
      ...(options.overlap !== undefined ? { overlap: options.overlap } : {}),
      ...(options.backfill ? { backfill: true } : {}),
    },
  );

  const schedule = await handle.describe();
  return {
    stdout: formatScheduleCommandOutput(schedule, options.json, `Created schedule ${handle.id}`),
    exitCode: 0,
  };
}

async function executeScheduleMutation(
  options: ScheduleMutationCommand,
  engine: Engine,
): Promise<CommandOutput> {
  if (!options.scheduleId) {
    return {
      stdout: '',
      stderr: `Error: scheduleId is required for schedule ${options.action}`,
      exitCode: 1,
    };
  }

  if (options.action === 'pause') {
    await engine.pauseSchedule(options.scheduleId);
    const schedule = await engine.getSchedule(options.scheduleId);
    return {
      stdout: formatScheduleCommandOutput(
        schedule,
        options.json,
        `Paused schedule ${options.scheduleId}`,
      ),
      exitCode: 0,
    };
  }

  if (options.action === 'resume') {
    await engine.resumeSchedule(options.scheduleId);
    const schedule = await engine.getSchedule(options.scheduleId);
    return {
      stdout: formatScheduleCommandOutput(
        schedule,
        options.json,
        `Resumed schedule ${options.scheduleId}`,
      ),
      exitCode: 0,
    };
  }

  await engine.cancelSchedule(options.scheduleId);
  const schedule = await engine.getSchedule(options.scheduleId);
  return {
    stdout: formatScheduleCommandOutput(
      schedule,
      options.json,
      `Cancelled schedule ${options.scheduleId}`,
    ),
    exitCode: 0,
  };
}

export async function executeSchedule(options: ScheduleCommand): Promise<CommandOutput> {
  const { Engine } = await import('./core/engine.ts');
  const { loadRegistrationsFromModule } = await import('./diagnostics/validate.ts');
  const storage = await createStorage(options.storage, options.database);
  const engine = new Engine({ storage });

  try {
    if (options.action === 'list') {
      return await executeScheduleList(options, engine);
    }

    if (options.action === 'create') {
      return await executeScheduleCreate(options, engine, loadRegistrationsFromModule);
    }

    return await executeScheduleMutation(options, engine);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stdout: '', stderr: `Error: ${message}`, exitCode: 1 };
  } finally {
    await engine[Symbol.asyncDispose]();
    storage[Symbol.dispose]();
  }
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
