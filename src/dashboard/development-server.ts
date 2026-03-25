/**
 * Dashboard development server.
 *
 * Starts a Weft server with in-memory storage, sample workflows,
 * and the dashboard UI with hot module replacement.
 *
 * Usage: bun --hot src/dashboard/development-server.ts
 */

import { Engine } from '../core/engine.ts';
import type { StepWorkflowContext } from '../core/types.ts';
import { serve } from '../server/index.ts';

const dashboard: unknown = await import('./index.html');

const engine = new Engine();

// Register a sample step-based workflow for development
engine.register('example', async (context: StepWorkflowContext) => {
  const greeting = await context.step('greet', () => 'Hello from the example workflow!');
  return { message: greeting };
});

const server = serve({
  engine,
  port: 7233,
  development: true,
  dashboard,
});

console.log(`Weft dashboard running at ${server.url}/ui`);
console.log(`API available at ${server.url}/v1/health`);
