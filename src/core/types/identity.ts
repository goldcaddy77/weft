// ---------------------------------------------------------------------------
// Workflow identity
// ---------------------------------------------------------------------------

/**
 * Opaque string identifier for a workflow instance. Generated automatically
 * by the engine at start time, or supplied via {@link StartOptions.id}. Pass
 * to {@link Engine.getHandle} or {@link Engine.get} to look up a running or
 * completed workflow.
 *
 * @example
 * ```ts
 * import { Engine, type WorkflowId } from 'weft';
 *
 * const engine = new Engine();
 * engine.register('ping', async function* () { return 'pong'; });
 *
 * const handle = await engine.start('ping', null);
 * const id: WorkflowId = handle.id;
 * const state = await engine.get(id);
 * console.log(state?.status); // 'completed'
 * ```
 */
export type WorkflowId = string;

export type OperationId = string;

// ---------------------------------------------------------------------------
// Failure category — populated on all failed workflows
// ---------------------------------------------------------------------------

/**
 * Classifies why a workflow failed. Populated automatically by the engine on
 * failure so operators can query e.g. "all planning failures in the last hour"
 * via `engine.list({ attributes: [{ key: 'failureCategory', value: 'planning' }] })`.
 *
 * - `'memory'`    — context window exceeded (LLM / agent)
 * - `'reflection'` — never assigned by the engine today; reserved as a typed slot for future categorisation
 * - `'planning'`  — LLM produced an invalid tool call or schema violation
 * - `'action'`    — an agent tool execution threw
 * - `'system'`    — any other failure (default for non-agent errors, storage errors, etc.)
 *
 * @example
 * ```ts
 * import { Engine, type FailureCategory } from 'weft';
 *
 * const engine = new Engine();
 * // Query all workflows that failed due to a planning error:
 * const results = await engine.list({
 *   status: 'failed',
 *   attributes: [{ key: 'failureCategory', value: 'planning' as FailureCategory }],
 * });
 * void results;
 * ```
 */
export type FailureCategory = 'memory' | 'reflection' | 'planning' | 'action' | 'system';

// ---------------------------------------------------------------------------
// Workflow status state machine
// ---------------------------------------------------------------------------

/**
 * Lifecycle states a workflow moves through, from registration to terminal
 * state.
 *
 * Read this off `(await handle.state()).status` to learn whether a workflow
 * is still running, finished cleanly, or failed. Pass it to `engine.list()`
 * filters to scope queries by status.
 */
export type WorkflowStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed-out';
