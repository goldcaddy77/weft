import { describe, expect, it } from 'bun:test';

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type CliCommand,
  DOCTOR_HELP_TEXT,
  HELP_TEXT,
  VERSION_CHECK_HELP_TEXT,
  createStorage,
  executeDoctor,
  executeVersionCheck,
  parseCliArguments,
} from './cli.ts';

type ServeCommand = Extract<CliCommand, { command: 'serve' }>;
type DoctorCommand = Extract<CliCommand, { command: 'doctor' }>;
type VersionCheckCommand = Extract<CliCommand, { command: 'version:check' }>;

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
      const result = parseCliArguments(['--database', '/tmp/test.db']);
      expect(result.command).toBe('serve');
      expect(result.database).toBe('/tmp/test.db');
    });

    it('parses -d short flag for database', () => {
      const result = parseCliArguments(['-d', '/tmp/other.db']);
      expect(result.command).toBe('serve');
      expect(result.database).toBe('/tmp/other.db');
    });

    it('defaults database to ./weft.db', () => {
      const result = parseCliArguments([]);
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
      const result = parseCliArguments(['doctor', '--database', '/tmp/doc.db']);
      expect(result.command).toBe('doctor');
      expect(result.database).toBe('/tmp/doc.db');
    });

    it('parses -d short flag for database', () => {
      const result = parseCliArguments(['doctor', '-d', '/tmp/doc.db']);
      expect(result.command).toBe('doctor');
      expect(result.database).toBe('/tmp/doc.db');
    });

    it('defaults database to ./weft.db', () => {
      const result = parseCliArguments(['doctor']);
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
      const result = parseCliArguments(['version:check', '--database', '/tmp/vc.db']);
      expect(result.command).toBe('version:check');
      expect(result.database).toBe('/tmp/vc.db');
    });

    it('parses -d short flag for database', () => {
      const result = parseCliArguments(['version:check', '-d', '/tmp/vc.db']);
      expect(result.command).toBe('version:check');
      expect(result.database).toBe('/tmp/vc.db');
    });

    it('defaults database to ./weft.db', () => {
      const result = parseCliArguments(['version:check']);
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
});

describe('help text', () => {
  it('HELP_TEXT contains doctor subcommand', () => {
    expect(HELP_TEXT).toContain('doctor');
  });

  it('HELP_TEXT contains version:check subcommand', () => {
    expect(HELP_TEXT).toContain('version:check');
  });

  it('HELP_TEXT contains serve subcommand', () => {
    expect(HELP_TEXT).toContain('serve');
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
    expect(stdout).toContain('--database');
    expect(stdout).toContain('--help');
    expect(stdout).toContain('doctor');
    expect(stdout).toContain('version:check');
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

  it('runs doctor --help and exits 0', async () => {
    const process = Bun.spawn(['bun', './src/cli.ts', 'doctor', '--help'], {
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
    const process = Bun.spawn(['bun', './src/cli.ts', 'version:check', '--help'], {
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
    const process = Bun.spawn(['bun', './src/cli.ts', 'doctor', '--database', ':memory:'], {
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
      ['bun', './src/cli.ts', 'doctor', '--database', ':memory:', '--json'],
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

  it('exits with error when version:check is missing --workflows flag', async () => {
    const process = Bun.spawn(['bun', './src/cli.ts', 'version:check', '--database', ':memory:'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stderr = await new Response(process.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain('--workflows');
  });

  it('starts the server and responds to health check', async () => {
    const port = 17233 + Math.floor(Math.random() * 1000);
    const process = Bun.spawn(
      ['bun', './src/cli.ts', '--port', String(port), '--database', ':memory:'],
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
    const process = Bun.spawn(['bun', './src/cli.ts', '--help', '--storage', 'memory'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    expect(exitCode).toBe(0);
  });

  it('accepts --no-ui flag via the CLI binary', async () => {
    const process = Bun.spawn(['bun', './src/cli.ts', '--help', '--no-ui'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    expect(exitCode).toBe(0);
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
