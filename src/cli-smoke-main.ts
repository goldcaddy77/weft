#!/usr/bin/env bun

import { helloWorldWorkflow } from '../examples/hello-world.ts';
import { createStorage } from './cli.ts';
import { Engine } from './core/engine.ts';
import type { WorkflowFunction } from './core/types.ts';
import { serve } from './server/index.ts';

const portArgument = Bun.argv.find((argument) => argument.startsWith('--port='));
const port = portArgument ? Number(portArgument.slice('--port='.length)) : 0;

const storage = await createStorage('memory', ':memory:');
const engine = new Engine({ storage });

// The example handler is typed as <string | undefined, { greeting: string }>;
// Engine.register's overload is invariant on its input type under
// exactOptionalPropertyTypes, so widen explicitly.
engine.register('helloWorld', helloWorldWorkflow.handler as WorkflowFunction);

const server = serve({ engine, port });

console.log(`SMOKE_READY ${server.url}`);

const shutdown = async () => {
  await server.stop();
  storage[Symbol.dispose]();
  process.exit(0);
};

process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});
