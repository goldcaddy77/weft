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

import { Engine } from './core/engine.ts';
import { serve } from './server/index.ts';
import { BunSQLiteStorage } from './storage/bun-sql.ts';

// ---------------------------------------------------------------------------
// Argument parsing (exported for testing)
// ---------------------------------------------------------------------------

export interface CliArguments {
  port: string;
  data: string;
  help: boolean;
}

export function parseCliArguments(args: string[]): CliArguments {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string', short: 'p', default: '7233' },
      data: { type: 'string', short: 'd', default: './weft.db' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  return {
    port: values.port ?? '7233',
    data: values.data ?? './weft.db',
    help: values.help ?? false,
  };
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP_TEXT = `
weft - Bun-native durable execution engine

Usage: weft [options]

Options:
  -p, --port <port>   Server port (default: 7233)
  -d, --data <path>   Database file path (default: ./weft.db)
  -h, --help          Show this help message
`;

// ---------------------------------------------------------------------------
// Main (only runs when executed directly, not when imported for tests)
// ---------------------------------------------------------------------------

const isDirectExecution = typeof Bun !== 'undefined' && Bun.main === import.meta.path;

if (isDirectExecution) {
  const parsed = parseCliArguments(Bun.argv.slice(2));

  if (parsed.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const storage = new BunSQLiteStorage(parsed.data);
  const engine = new Engine({ storage });

  const server = serve({
    engine,
    port: Number(parsed.port),
  });

  console.log(`Weft running on ${server.url}`);
  console.log(`Database: ${parsed.data}`);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    server.stop();
    storage[Symbol.dispose]();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    server.stop();
    storage[Symbol.dispose]();
    process.exit(0);
  });
}
