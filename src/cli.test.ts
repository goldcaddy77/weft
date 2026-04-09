import { describe, expect, it } from 'bun:test';

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type CliCommand,
  DOCTOR_HELP_TEXT,
  HELP_TEXT,
  VALIDATE_HELP_TEXT,
  VERSION_CHECK_HELP_TEXT,
  createStorage,
  executeDoctor,
  executeValidate,
  executeVersionCheck,
  parseCliArguments,
} from './cli.ts';
import { encode } from './core/codec.ts';
import { KEYS } from './storage/interface.ts';

type ServeCommand = Extract<CliCommand, { command: 'serve' }>;
type DoctorCommand = Extract<CliCommand, { command: 'doctor' }>;
type VersionCheckCommand = Extract<CliCommand, { command: 'version:check' }>;
type ValidateCommand = Extract<CliCommand, { command: 'validate' }>;

describe('CLI argument parsing', () => {
  describe('default subcommand (serve)', () => {
    it('defaults to serve when no subcommand is provided', () => {
      const result = parseCliArguments([]);
      expect(result.command).toBe('serve');
    });

    it('parses --port flag', () => {
      const result = parseCliArguments(['--port', '8080']) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.port).toBe('8080');
    });

    it('parses -p short flag for port', () => {
      const result = parseCliArguments(['-p', '9999']) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.port).toBe('9999');
    });

    it('defaults port to 7233', () => {
      const result = parseCliArguments([]) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.port).toBe('7233');
    });

    it('parses --database flag', () => {
      const result = parseCliArguments(['--database', '/tmp/test.db']) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.database).toBe('/tmp/test.db');
    });

    it('parses -d short flag for database', () => {
      const result = parseCliArguments(['-d', '/tmp/other.db']) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.database).toBe('/tmp/other.db');
    });

    it('defaults database to ./weft.db', () => {
      const result = parseCliArguments([]) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.database).toBe('./weft.db');
    });

    it('parses --help flag', () => {
      const result = parseCliArguments(['--help']);
      expect(result.command).toBe('serve');
      expect(result.help).toBe(true);
    });

    it('defaults help to false', () => {
      const result = parseCliArguments([]);
      expect(result.command).toBe('serve');
      expect(result.help).toBe(false);
    });

    it('parses multiple flags together', () => {
      const result = parseCliArguments([
        '--port',
        '3000',
        '--database',
        '/var/weft.db',
      ]) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.port).toBe('3000');
      expect(result.database).toBe('/var/weft.db');
    });

    it('parses -h short flag for help', () => {
      const result = parseCliArguments(['-h']);
      expect(result.command).toBe('serve');
      expect(result.help).toBe(true);
    });

    it('allows positional arguments without error', () => {
      const result = parseCliArguments(['positional-arg', '--port', '5000']) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.port).toBe('5000');
    });

    it('parses --storage flag with sqlite', () => {
      const result = parseCliArguments(['--storage', 'sqlite']) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.storage).toBe('sqlite');
    });

    it('parses --storage flag with lmdb', () => {
      const result = parseCliArguments(['--storage', 'lmdb']) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.storage).toBe('lmdb');
    });

    it('parses --storage flag with memory', () => {
      const result = parseCliArguments(['--storage', 'memory']) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.storage).toBe('memory');
    });

    it('throws for an invalid storage backend', () => {
      expect(() => parseCliArguments(['--storage', 'postgres'])).toThrow(
        "Invalid storage backend 'postgres'",
      );
    });

    it('parses -s short flag for storage', () => {
      const result = parseCliArguments(['-s', 'lmdb']) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.storage).toBe('lmdb');
    });

    it('defaults storage to sqlite', () => {
      const result = parseCliArguments([]) as ServeCommand;
      expect(result.storage).toBe('sqlite');
    });

    it('enables ui by default', () => {
      const result = parseCliArguments([]) as ServeCommand;
      expect(result.ui).toBe(true);
    });

    it('parses --no-ui to disable the dashboard', () => {
      const result = parseCliArguments(['--no-ui']) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.ui).toBe(false);
    });

    it('parses all flags combined', () => {
      const result = parseCliArguments([
        '-p',
        '4000',
        '-d',
        '/tmp/all.db',
        '-s',
        'memory',
        '--no-ui',
        '-h',
      ]) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.port).toBe('4000');
      expect(result.database).toBe('/tmp/all.db');
      expect(result.storage).toBe('memory');
      expect(result.ui).toBe(false);
      expect(result.help).toBe(true);
    });

    it('throws on unknown flags due to strict mode', () => {
      expect(() => parseCliArguments(['--unknown-flag'])).toThrow();
    });

    it('treats an unknown subcommand as a positional for serve', () => {
      const result = parseCliArguments(['something-else', '--port', '4444']) as ServeCommand;
      expect(result.command).toBe('serve');
      expect(result.port).toBe('4444');
    });
  });

  describe('doctor subcommand', () => {
    it('returns command doctor when doctor is the first positional', () => {
      const result = parseCliArguments(['doctor']);
      expect(result.command).toBe('doctor');
    });

    it('parses --database flag', () => {
      const result = parseCliArguments(['doctor', '--database', '/tmp/doc.db']) as DoctorCommand;
      expect(result.command).toBe('doctor');
      expect(result.database).toBe('/tmp/doc.db');
    });

    it('parses -d short flag for database', () => {
      const result = parseCliArguments(['doctor', '-d', '/tmp/doc.db']) as DoctorCommand;
      expect(result.command).toBe('doctor');
      expect(result.database).toBe('/tmp/doc.db');
    });

    it('defaults database to ./weft.db', () => {
      const result = parseCliArguments(['doctor']) as DoctorCommand;
      expect(result.command).toBe('doctor');
      expect(result.database).toBe('./weft.db');
    });

    it('parses --help flag', () => {
      const result = parseCliArguments(['doctor', '--help']);
      expect(result.command).toBe('doctor');
      expect(result.help).toBe(true);
    });

    it('parses -h short flag for help', () => {
      const result = parseCliArguments(['doctor', '-h']);
      expect(result.command).toBe('doctor');
      expect(result.help).toBe(true);
    });

    it('defaults help to false', () => {
      const result = parseCliArguments(['doctor']);
      expect(result.command).toBe('doctor');
      expect(result.help).toBe(false);
    });

    it('parses --json flag', () => {
      const result = parseCliArguments(['doctor', '--json']) as DoctorCommand;
      expect(result.command).toBe('doctor');
      expect(result.json).toBe(true);
    });

    it('parses -j short flag for json', () => {
      const result = parseCliArguments(['doctor', '-j']) as DoctorCommand;
      expect(result.command).toBe('doctor');
      expect(result.json).toBe(true);
    });

    it('defaults json to false', () => {
      const result = parseCliArguments(['doctor']) as DoctorCommand;
      expect(result.command).toBe('doctor');
      expect(result.json).toBe(false);
    });

    it('parses multiple flags together', () => {
      const result = parseCliArguments(['doctor', '-d', '/tmp/doc.db', '--json']) as DoctorCommand;
      expect(result.command).toBe('doctor');
      expect(result.database).toBe('/tmp/doc.db');
      expect(result.json).toBe(true);
    });

    it('throws on unknown flags due to strict mode', () => {
      expect(() => parseCliArguments(['doctor', '--port', '8080'])).toThrow();
    });
  });

  describe('version:check subcommand', () => {
    it('returns command version:check when version:check is the first positional', () => {
      const result = parseCliArguments(['version:check']);
      expect(result.command).toBe('version:check');
    });

    it('parses --database flag', () => {
      const result = parseCliArguments([
        'version:check',
        '--database',
        '/tmp/vc.db',
      ]) as VersionCheckCommand;
      expect(result.command).toBe('version:check');
      expect(result.database).toBe('/tmp/vc.db');
    });

    it('parses -d short flag for database', () => {
      const result = parseCliArguments([
        'version:check',
        '-d',
        '/tmp/vc.db',
      ]) as VersionCheckCommand;
      expect(result.command).toBe('version:check');
      expect(result.database).toBe('/tmp/vc.db');
    });

    it('defaults database to ./weft.db', () => {
      const result = parseCliArguments(['version:check']) as VersionCheckCommand;
      expect(result.command).toBe('version:check');
      expect(result.database).toBe('./weft.db');
    });

    it('parses --workflows flag', () => {
      const result = parseCliArguments([
        'version:check',
        '--workflows',
        './workflows.ts',
      ]) as VersionCheckCommand;
      expect(result.command).toBe('version:check');
      expect(result.workflows).toBe('./workflows.ts');
    });

    it('parses -w short flag for workflows', () => {
      const result = parseCliArguments(['version:check', '-w', './wf.ts']) as VersionCheckCommand;
      expect(result.command).toBe('version:check');
      expect(result.workflows).toBe('./wf.ts');
    });

    it('defaults workflows to empty string', () => {
      const result = parseCliArguments(['version:check']) as VersionCheckCommand;
      expect(result.command).toBe('version:check');
      expect(result.workflows).toBe('');
    });

    it('parses --help flag', () => {
      const result = parseCliArguments(['version:check', '--help']);
      expect(result.command).toBe('version:check');
      expect(result.help).toBe(true);
    });

    it('parses -h short flag for help', () => {
      const result = parseCliArguments(['version:check', '-h']);
      expect(result.command).toBe('version:check');
      expect(result.help).toBe(true);
    });

    it('defaults help to false', () => {
      const result = parseCliArguments(['version:check']);
      expect(result.command).toBe('version:check');
      expect(result.help).toBe(false);
    });

    it('parses --json flag', () => {
      const result = parseCliArguments(['version:check', '--json']) as VersionCheckCommand;
      expect(result.command).toBe('version:check');
      expect(result.json).toBe(true);
    });

    it('parses -j short flag for json', () => {
      const result = parseCliArguments(['version:check', '-j']) as VersionCheckCommand;
      expect(result.command).toBe('version:check');
      expect(result.json).toBe(true);
    });

    it('defaults json to false', () => {
      const result = parseCliArguments(['version:check']) as VersionCheckCommand;
      expect(result.command).toBe('version:check');
      expect(result.json).toBe(false);
    });

    it('parses all flags together', () => {
      const result = parseCliArguments([
        'version:check',
        '-d',
        '/tmp/vc.db',
        '-w',
        './wf.ts',
        '-j',
        '-h',
      ]) as VersionCheckCommand;
      expect(result.command).toBe('version:check');
      expect(result.database).toBe('/tmp/vc.db');
      expect(result.workflows).toBe('./wf.ts');
      expect(result.json).toBe(true);
      expect(result.help).toBe(true);
    });

    it('throws on unknown flags due to strict mode', () => {
      expect(() => parseCliArguments(['version:check', '--port', '8080'])).toThrow();
    });
  });

  describe('validate subcommand', () => {
    it('returns command validate when validate is the first positional', () => {
      const result = parseCliArguments(['validate']);
      expect(result.command).toBe('validate');
    });

    it('parses entry path as first positional argument', () => {
      const result = parseCliArguments(['validate', './my-workflow.ts']) as ValidateCommand;
      expect(result.command).toBe('validate');
      expect(result.entryPath).toBe('./my-workflow.ts');
    });

    it('defaults entryPath to empty string when no positional is given', () => {
      const result = parseCliArguments(['validate']) as ValidateCommand;
      expect(result.entryPath).toBe('');
    });

    it('parses --json flag', () => {
      const result = parseCliArguments(['validate', 'entry.ts', '--json']) as ValidateCommand;
      expect(result.json).toBe(true);
    });

    it('parses -j short flag for json', () => {
      const result = parseCliArguments(['validate', 'entry.ts', '-j']) as ValidateCommand;
      expect(result.json).toBe(true);
    });

    it('defaults json to false', () => {
      const result = parseCliArguments(['validate']) as ValidateCommand;
      expect(result.json).toBe(false);
    });

    it('parses --help flag', () => {
      const result = parseCliArguments(['validate', '--help']) as ValidateCommand;
      expect(result.help).toBe(true);
    });

    it('parses -h short flag for help', () => {
      const result = parseCliArguments(['validate', '-h']) as ValidateCommand;
      expect(result.help).toBe(true);
    });

    it('defaults help to false', () => {
      const result = parseCliArguments(['validate']) as ValidateCommand;
      expect(result.help).toBe(false);
    });

    it('throws on unknown flags due to strict mode', () => {
      expect(() => parseCliArguments(['validate', '--port', '8080'])).toThrow();
    });
  });
});

describe('help text', () => {
  it('HELP_TEXT contains doctor subcommand', () => {
    expect(HELP_TEXT).toContain('doctor');
  });

  it('HELP_TEXT contains version:check subcommand', () => {
    expect(HELP_TEXT).toContain('version:check');
  });

  it('HELP_TEXT contains validate subcommand', () => {
    expect(HELP_TEXT).toContain('validate');
  });

  it('HELP_TEXT contains serve subcommand', () => {
    expect(HELP_TEXT).toContain('serve');
  });

  it('VALIDATE_HELP_TEXT contains exit codes section', () => {
    expect(VALIDATE_HELP_TEXT).toContain('Exit codes');
    expect(VALIDATE_HELP_TEXT).toContain('0');
    expect(VALIDATE_HELP_TEXT).toContain('1');
    expect(VALIDATE_HELP_TEXT).toContain('2');
  });

  it('VALIDATE_HELP_TEXT contains checks section', () => {
    expect(VALIDATE_HELP_TEXT).toContain('unbounded-retry');
    expect(VALIDATE_HELP_TEXT).toContain('stateful-without-compensator');
  });

  it('VALIDATE_HELP_TEXT contains --json and --help flags', () => {
    expect(VALIDATE_HELP_TEXT).toContain('--json');
    expect(VALIDATE_HELP_TEXT).toContain('--help');
  });

  it('DOCTOR_HELP_TEXT contains --database flag', () => {
    expect(DOCTOR_HELP_TEXT).toContain('--database');
  });

  it('DOCTOR_HELP_TEXT contains --json flag', () => {
    expect(DOCTOR_HELP_TEXT).toContain('--json');
  });

  it('DOCTOR_HELP_TEXT contains --help flag', () => {
    expect(DOCTOR_HELP_TEXT).toContain('--help');
  });

  it('VERSION_CHECK_HELP_TEXT contains --database flag', () => {
    expect(VERSION_CHECK_HELP_TEXT).toContain('--database');
  });

  it('VERSION_CHECK_HELP_TEXT contains --workflows flag', () => {
    expect(VERSION_CHECK_HELP_TEXT).toContain('--workflows');
  });

  it('VERSION_CHECK_HELP_TEXT contains --json flag', () => {
    expect(VERSION_CHECK_HELP_TEXT).toContain('--json');
  });

  it('VERSION_CHECK_HELP_TEXT contains --help flag', () => {
    expect(VERSION_CHECK_HELP_TEXT).toContain('--help');
  });

  it('HELP_TEXT documents --storage flag', () => {
    expect(HELP_TEXT).toContain('--storage');
  });

  it('HELP_TEXT documents --no-ui flag', () => {
    expect(HELP_TEXT).toContain('--no-ui');
  });

  it('HELP_TEXT lists all storage backends', () => {
    expect(HELP_TEXT).toContain('sqlite');
    expect(HELP_TEXT).toContain('lmdb');
    expect(HELP_TEXT).toContain('memory');
  });
});

describe('executeDoctor', () => {
  it('returns a formatted report for an in-memory database', async () => {
    const result = await executeDoctor({ database: ':memory:', json: false });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Database:');
    expect(result.stdout).toContain('Workflows:');
    expect(result.stdout).toContain('Activities:');
    expect(result.stdout).toContain('Recommendations:');
  });

  it('returns JSON when json option is true', async () => {
    const result = await executeDoctor({ database: ':memory:', json: true });
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toHaveProperty('database');
    expect(report).toHaveProperty('workflows');
    expect(report).toHaveProperty('queues');
    expect(report).toHaveProperty('recommendations');
  });
});

describe('executeVersionCheck', () => {
  it('returns an error when workflows path is empty', async () => {
    const result = await executeVersionCheck({
      database: ':memory:',
      workflows: '',
      json: false,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--workflows');
  });

  it('returns a JSON report for a valid workflows module', async () => {
    const database = join(tmpdir(), `weft-version-check-${crypto.randomUUID()}.db`);
    const workflows = join(tmpdir(), `weft-workflows-${crypto.randomUUID()}.ts`);
    const storage = await createStorage('sqlite', database);

    try {
      await storage.put(
        KEYS.workflow('wf-version-check'),
        encode({
          id: 'wf-version-check',
          type: 'order',
          status: 'running',
          input: null,
          version: '1.0.0',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );

      await Bun.write(
        workflows,
        [
          'export default {',
          '  order: {',
          '    version: "1.0.0",',
          '    handler: async function* () {',
          '      return null;',
          '    },',
          '  },',
          '};',
        ].join('\n'),
      );

      const workflowModule = await import(workflows);
      const registrations = workflowModule.default as Record<
        string,
        { handler: () => AsyncGenerator<unknown, unknown, unknown> }
      >;
      const generator = registrations['order']!.handler();
      await generator.next();

      const result = await executeVersionCheck({
        database,
        workflows,
        json: true,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBeUndefined();
      expect(JSON.parse(result.stdout)).toMatchObject({
        overallVerdict: 'safe',
        workflowTypes: [
          {
            type: 'order',
            storedVersion: '1.0.0',
            registeredVersion: '1.0.0',
          },
        ],
      });
    } finally {
      storage[Symbol.dispose]();
      rmSync(workflows, { force: true });
      rmSync(database, { force: true });
    }
  });
});

describe('CLI direct execution', () => {
  it('runs the CLI binary with --help and exits 0', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('weft');
    expect(stdout).toContain('--port');
    expect(stdout).toContain('--database');
    expect(stdout).toContain('--help');
    expect(stdout).toContain('doctor');
    expect(stdout).toContain('version:check');
  });

  it('runs the CLI binary with -h short flag and exits 0', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', '-h'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('weft');
  });

  it('runs doctor --help and exits 0', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', 'doctor', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('doctor');
    expect(stdout).toContain('--database');
    expect(stdout).toContain('--json');
  });

  it('runs version:check --help and exits 0', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', 'version:check', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('version:check');
    expect(stdout).toContain('--database');
    expect(stdout).toContain('--workflows');
    expect(stdout).toContain('--json');
  });

  it('runs doctor against an in-memory database and exits 0', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', 'doctor', '--database', ':memory:'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Database:');
    expect(stdout).toContain('Workflows:');
    expect(stdout).toContain('Activities:');
    expect(stdout).toContain('Recommendations:');
  });

  it('runs doctor with --json flag and outputs valid JSON', async () => {
    const process = Bun.spawn(
      ['bun', './src/cli-main.ts', 'doctor', '--database', ':memory:', '--json'],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout);
    expect(report).toHaveProperty('database');
    expect(report).toHaveProperty('workflows');
    expect(report).toHaveProperty('queues');
    expect(report).toHaveProperty('recommendations');
  });

  it('exits with an error for an invalid storage backend', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', '--storage', 'postgres'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stderr = await new Response(process.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Invalid storage backend 'postgres'");
  });

  it('exits with error when version:check is missing --workflows flag', async () => {
    const process = Bun.spawn(
      ['bun', './src/cli-main.ts', 'version:check', '--database', ':memory:'],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    const exitCode = await process.exited;
    const stderr = await new Response(process.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain('--workflows');
  });

  it('starts the server and responds to health check', async () => {
    const port = 17233 + Math.floor(Math.random() * 1000);
    const process = Bun.spawn(
      ['bun', './src/cli-main.ts', '--port', String(port), '--database', ':memory:'],
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

  it('accepts --storage flag via the CLI binary', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', '--help', '--storage', 'memory'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    expect(exitCode).toBe(0);
  });

  it('accepts --no-ui flag via the CLI binary', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', '--help', '--no-ui'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    expect(exitCode).toBe(0);
  });
});

describe('executeValidate', () => {
  it('returns exitCode 2 and stderr when entryPath is empty', async () => {
    const result = await executeValidate({ entryPath: '', json: false });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('entry file path is required');
    expect(result.stdout).toBe('');
  });

  it('returns exitCode 2 and stderr when entry file does not exist', async () => {
    const result = await executeValidate({
      entryPath: '/does/not/exist/entry.ts',
      json: false,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('could not load entry file');
  });

  it('returns exitCode 0 and stdout with no-issues message for a clean module', async () => {
    const entryPath = join(tmpdir(), `weft-validate-clean-${crypto.randomUUID()}.ts`);
    try {
      await Bun.write(
        entryPath,
        [
          'import type { WorkflowRegistration } from "./src/core/types.ts";',
          'export const myWorkflow: WorkflowRegistration = {',
          '  handler: async function* () { return "done"; },',
          '};',
        ].join('\n'),
      );

      const result = await executeValidate({ entryPath, json: false });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No issues found.');
    } finally {
      rmSync(entryPath, { force: true });
    }
  });

  it('returns exitCode 1 when an activity has unbounded retry', async () => {
    const entryPath = join(tmpdir(), `weft-validate-error-${crypto.randomUUID()}.ts`);
    try {
      await Bun.write(
        entryPath,
        [
          'import type { ActivityDefinition } from "./src/core/types.ts";',
          'export const badActivity: ActivityDefinition = {',
          '  name: "badActivity",',
          '  execute: async (input: unknown) => input,',
          '  idempotent: true,',
          '  retry: { maxAttempts: Infinity, initialBackoff: "1s", backoffMultiplier: 2, maxBackoff: "30s" },',
          '};',
        ].join('\n'),
      );

      const result = await executeValidate({ entryPath, json: false });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('unbounded-retry');
    } finally {
      rmSync(entryPath, { force: true });
    }
  });

  it('returns valid JSON when json: true', async () => {
    const entryPath = join(tmpdir(), `weft-validate-json-${crypto.randomUUID()}.ts`);
    try {
      await Bun.write(
        entryPath,
        [
          'import type { WorkflowRegistration } from "./src/core/types.ts";',
          'export const myWorkflow: WorkflowRegistration = {',
          '  handler: async function* () { return "done"; },',
          '};',
        ].join('\n'),
      );

      const result = await executeValidate({ entryPath, json: true });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toMatchObject({ valid: true, issues: [], workflowCount: expect.any(Number) });
    } finally {
      rmSync(entryPath, { force: true });
    }
  });
});

describe('loadRegistrationsFromModule', () => {
  it('extracts WorkflowRegistration from named exports', async () => {
    const { loadRegistrationsFromModule } = await import('./diagnostics/validate.ts');
    const entryPath = join(tmpdir(), `weft-load-named-${crypto.randomUUID()}.ts`);
    try {
      await Bun.write(
        entryPath,
        [
          'import type { WorkflowRegistration } from "./src/core/types.ts";',
          'export const myWorkflow: WorkflowRegistration = {',
          '  handler: async function* () { return "done"; },',
          '};',
        ].join('\n'),
      );
      const result = await loadRegistrationsFromModule(entryPath);
      expect('myWorkflow' in result.registrations).toBe(true);
      expect(result.activities).toHaveLength(0);
    } finally {
      rmSync(entryPath, { force: true });
    }
  });

  it('extracts ActivityDefinition from named exports', async () => {
    const { loadRegistrationsFromModule } = await import('./diagnostics/validate.ts');
    const entryPath = join(tmpdir(), `weft-load-activity-${crypto.randomUUID()}.ts`);
    try {
      await Bun.write(
        entryPath,
        [
          'import type { ActivityDefinition } from "./src/core/types.ts";',
          'export const sendEmail: ActivityDefinition = {',
          '  name: "sendEmail",',
          '  execute: async (input: unknown) => input,',
          '};',
        ].join('\n'),
      );
      const result = await loadRegistrationsFromModule(entryPath);
      expect(result.activities).toHaveLength(1);
      expect(result.activities[0]!.name).toBe('sendEmail');
    } finally {
      rmSync(entryPath, { force: true });
    }
  });

  it('rejects with an error for a non-existent file', async () => {
    const { loadRegistrationsFromModule } = await import('./diagnostics/validate.ts');
    await expect(loadRegistrationsFromModule('/does/not/exist/workflow.ts')).rejects.toThrow();
  });

  it('returns empty registrations and activities for a module with no matching exports', async () => {
    const { loadRegistrationsFromModule } = await import('./diagnostics/validate.ts');
    const entryPath = join(tmpdir(), `weft-load-empty-${crypto.randomUUID()}.ts`);
    try {
      await Bun.write(entryPath, 'export const foo = 42;\n');
      const result = await loadRegistrationsFromModule(entryPath);
      expect(Object.keys(result.registrations)).toHaveLength(0);
      expect(result.activities).toHaveLength(0);
    } finally {
      rmSync(entryPath, { force: true });
    }
  });
});

describe('createStorage', () => {
  it('creates BunSQLiteStorage for sqlite backend', async () => {
    const storage = await createStorage('sqlite', ':memory:');
    expect(storage).toBeDefined();
    expect(typeof storage.get).toBe('function');
    expect(typeof storage.put).toBe('function');
    storage[Symbol.dispose]();
  });

  it('creates MemoryStorage for memory backend', async () => {
    const storage = await createStorage('memory', './unused.db');
    expect(storage).toBeDefined();
    expect(typeof storage.get).toBe('function');
    expect(typeof storage.put).toBe('function');
    storage[Symbol.dispose]();
  });

  it('creates LMDBStorage for lmdb backend', async () => {
    const path = join(
      tmpdir(),
      `lmdb-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const storage = await createStorage('lmdb', path);

    expect(storage).toBeDefined();
    expect(typeof storage.get).toBe('function');
    expect(typeof storage.put).toBe('function');
    storage[Symbol.dispose]();

    if (existsSync(path)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('returns storage implementing get/put/delete/scan', async () => {
    const storage = await createStorage('memory', '');

    await storage.put('test-key', new Uint8Array([1, 2, 3]));
    const result = await storage.get('test-key');
    expect(result).toEqual(new Uint8Array([1, 2, 3]));

    await storage.delete('test-key');
    const deleted = await storage.get('test-key');
    expect(deleted).toBeNull();

    storage[Symbol.dispose]();
  });
});
