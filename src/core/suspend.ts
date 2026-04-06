/**
 * Serverless-style workflow suspension.
 *
 * `ctx.suspendUntil({ resumeToken })` pauses a workflow until an external
 * caller (e.g. a webhook from an LLM provider or a payment gateway) delivers
 * the matching token with a payload. The semantics line up with
 * `ctx.waitForSignal(name)` — both yield, persist a checkpoint, and release
 * control until the next event arrives — but `suspendUntil` surfaces the
 * "suspend here, resume via webhook" intent more clearly and keeps the
 * signal name generation under one obvious API.
 *
 * ## Resuming a suspended workflow
 *
 * External code resumes a suspended workflow by dispatching a signal whose
 * `name` is the resume token. The signal endpoint is already part of the
 * public API:
 *
 * ```
 * POST /v1/workflows/{workflowId}/signal/{resumeToken}
 * Content-Type: application/json
 *
 * { "payload": { "status": "ready", "data": [...] } }
 * ```
 *
 * The payload becomes the return value of `ctx.suspendUntil()` on the
 * resumed workflow. Programmatic callers use `engine.signal(workflowId,
 * resumeToken, payload)`.
 *
 * ## Why this closes the "serverless suspension" gap
 *
 * Inngest's `step.ai.infer()` and Restate's journal-based suspension stop
 * worker processes during LLM waits. Weft achieves the same shape via
 * checkpoint-persisted suspension: once `suspendUntil` yields, the workflow
 * is parked in storage and the worker is free to pick up other work. When
 * the resume signal arrives, the engine reads the checkpoint and keeps
 * going. LLM providers that can return a resume hint (instead of blocking
 * the worker for the whole completion) can opt in by issuing the hint as
 * the resume token and calling back once the completion is ready.
 *
 * @module core/suspend
 */

/**
 * Options accepted by `ctx.suspendUntil()`.
 *
 * A `resumeToken` is required: the workflow has to know which token to
 * expose to the outside world before suspending. Callers typically generate
 * one with `crypto.randomUUID()` and pass it to the external system during
 * the step that precedes suspension.
 */
export interface SuspendUntilOptions {
  /**
   * The token that external code will supply to resume the workflow. Must
   * be unique per suspension within a workflow — typically a UUID.
   */
  resumeToken: string;
}

/**
 * Payload shape accepted by `POST /v1/workflows/:id/resume`. The engine
 * delivers `result` to the workflow as the return value of the matching
 * `ctx.suspendUntil()` call.
 */
export interface ResumeRequestBody {
  token: string;
  result?: unknown;
}

/**
 * Type guard for a well-formed resume request body. Use in HTTP handlers to
 * reject malformed payloads before calling into the engine.
 */
export function isResumeRequestBody(value: unknown): value is ResumeRequestBody {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate['token'] === 'string';
}

/**
 * Generate a fresh resume token. Convenience helper so workflow code doesn't
 * have to import `crypto` directly and so tests can stub it if needed.
 *
 * @example
 * ```ts
 * import { generateResumeToken } from 'weft';
 *
 * engine.register('wait-for-callback', async function* (ctx) {
 *   const token = generateResumeToken();
 *   yield* ctx.run(notifyExternalSystem, { token });
 *   const result = yield* ctx.suspendUntil({ resumeToken: token });
 *   return result;
 * });
 * ```
 */
export function generateResumeToken(): string {
  return `suspend-${crypto.randomUUID()}`;
}
