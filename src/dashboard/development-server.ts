/**
 * Dashboard development server.
 *
 * Starts a Weft server with in-memory storage, sample workflows,
 * and the dashboard UI with hot module replacement.
 *
 * Usage: bun --hot src/dashboard/development-server.ts
 */

import { Engine } from '../core/engine.ts';
import { registerOnRuntimeEngine, runtimeWorkflowEngine } from '../core/runtime-workflow-engine.ts';
import { compileStepWorkflow } from '../core/step-context.ts';
import { workflow, type StepWorkflowContext } from '../core/types.ts';
import { serve } from '../server/index.ts';

const dashboardModule = await import('./index.html');
const dashboard: unknown = dashboardModule.default;

const engine = new Engine();

// Register a sample step-based workflow for development
registerOnRuntimeEngine(
  runtimeWorkflowEngine(engine),
  workflow({ name: 'example' }).execute(
    compileStepWorkflow(async (context: StepWorkflowContext) => {
      const greeting = await context.step('greet', () => 'Hello from the example workflow!');
      return { message: greeting };
    }),
  ),
);

const server = serve({
  engine,
  port: 7233,
  development: true,
  dashboard,
});

console.log(`Weft dashboard running at ${server.url}`);
console.log(`API available at ${server.url}/v1/health`);
