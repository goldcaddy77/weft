#!/usr/bin/env bun

import {
  CODEGEN_HELP_TEXT,
  CONFORMANCE_HELP_TEXT,
  createStorage,
  DOCTOR_HELP_TEXT,
  executeCodegen,
  executeConformance,
  executeDoctor,
  executeSchedule,
  executeTimeline,
  executeValidate,
  executeVersionCheck,
  HELP_TEXT,
  parseCliArguments,
  SCHEDULE_HELP_TEXT,
  TIMELINE_HELP_TEXT,
  VALIDATE_HELP_TEXT,
  VERSION_CHECK_HELP_TEXT,
} from './cli/index.ts';
import { Engine } from './core/engine.ts';
import { serve } from './server/index.ts';

const parsedArguments = (() => {
  try {
    return parseCliArguments(Bun.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
})();

if (parsedArguments.command === 'serve') {
  if (parsedArguments.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const storage = await createStorage(parsedArguments.storage, parsedArguments.database);
  const engine = new Engine({ storage });

  let dashboard: unknown = null;
  if (parsedArguments.ui) {
    try {
      const dashboardModule = await import('./dashboard/index.html' as string);
      dashboard = dashboardModule.default;
    } catch {
      // Dashboard not built — serve without it.
    }
  }

  const server = serve({
    engine,
    port: Number(parsedArguments.port),
    dashboard,
  });

  console.log(`Weft running on ${server.url}`);
  if (dashboard !== null) {
    console.log(`Dashboard: ${server.url}/ui`);
  }
  console.log(`Storage: ${parsedArguments.storage}`);
  console.log(`Database: ${parsedArguments.database}`);

  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    void server
      .stop()
      .then(() => {
        storage[Symbol.dispose]();
        process.exit(0);
      })
      .catch((error) => {
        console.error('[weft] Shutdown error:', error);
        process.exit(1);
      });
  });

  process.on('SIGTERM', () => {
    void server
      .stop()
      .then(() => {
        storage[Symbol.dispose]();
        process.exit(0);
      })
      .catch((error) => {
        console.error('[weft] Shutdown error:', error);
        process.exit(1);
      });
  });
} else if (parsedArguments.command === 'doctor') {
  if (parsedArguments.help) {
    console.log(DOCTOR_HELP_TEXT);
    process.exit(0);
  }

  const result = await executeDoctor(parsedArguments);
  console.log(result.stdout);
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'version:check') {
  if (parsedArguments.help) {
    console.log(VERSION_CHECK_HELP_TEXT);
    process.exit(0);
  }

  const result = await executeVersionCheck(parsedArguments);
  if (result.stderr) console.error(result.stderr);
  if (result.stdout) console.log(result.stdout);
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'validate') {
  if (parsedArguments.help) {
    console.log(VALIDATE_HELP_TEXT);
    process.exit(0);
  }

  const result = await executeValidate(parsedArguments);
  if (result.stderr) console.error(result.stderr);
  if (result.stdout) console.log(result.stdout);
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'conformance') {
  if (parsedArguments.help) {
    console.log(CONFORMANCE_HELP_TEXT);
    process.exit(0);
  }

  const result = await executeConformance(parsedArguments);
  if (result.stderr) console.error(result.stderr);
  if (result.stdout) console.log(result.stdout);
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'timeline') {
  if (parsedArguments.help) {
    console.log(TIMELINE_HELP_TEXT);
    process.exit(0);
  }

  const result = await executeTimeline(parsedArguments);
  if (result.stderr) console.error(result.stderr);
  if (result.stdout) console.log(result.stdout);
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'schedule') {
  if (parsedArguments.help) {
    console.log(SCHEDULE_HELP_TEXT);
    process.exit(0);
  }

  const result = await executeSchedule(parsedArguments);
  if (result.stderr) console.error(result.stderr);
  if (result.stdout) console.log(result.stdout);
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'codegen') {
  if (parsedArguments.help) {
    console.log(CODEGEN_HELP_TEXT);
    process.exit(0);
  }

  const result = await executeCodegen(parsedArguments);
  if (result.stderr) console.error(result.stderr);
  if (result.stdout) console.log(result.stdout);
  process.exit(result.exitCode);
}
