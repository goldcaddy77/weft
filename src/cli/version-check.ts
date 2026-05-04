import type { CommandOutput } from './types.ts';

/** Checks stored workflow history against the current workflow registrations. */
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

  const { runVersionCheck } = await import('../diagnostics/version-check.ts');
  const { formatVersionCheckReport } = await import('../diagnostics/format.ts');
  const { BunSQLiteStorage } = await import('../storage/bun-sql.ts');

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
