/**
 * Test-only wrapper around `handleRequest()` that opts into the
 * pre-Track-8 legacy compatibility shims.
 *
 * The internal flag this enables (`__legacyCompatInternal`) is not
 * exported from `handler.ts`, and `HandlerOptions` deliberately has no
 * field for it. This wrapper is the only path in the codebase that
 * flips the flag — production code cannot reach it.
 *
 * Usage:
 *   import { handleRequestWithLegacyCompat } from './handler-legacy-compat.ts';
 *   const response = await handleRequestWithLegacyCompat(request, engine, options);
 *
 * The wrapper exists for the regression-test harness only. Anything
 * that ships to end users must use the public `handleRequest()`.
 *
 * @module server/handler-legacy-compat
 */

import type { Engine } from '../core/engine.ts';
import { handleRequest, type HandlerOptions } from './handler.ts';

/**
 * Drop-in replacement for `handleRequest()` that activates the legacy
 * auto-grant and direct-handler-principal compatibility shims. Test-only.
 */
export async function handleRequestWithLegacyCompat(
  request: Request,
  engine: Engine,
  options?: HandlerOptions,
): Promise<Response> {
  // The internal flag is intentionally not part of HandlerOptions; we
  // attach it via a structural extension that handler.ts's dispatch
  // path knows how to read.
  const optionsWithFlag = {
    ...options,
    __legacyCompatInternal: true,
  };
  return handleRequest(request, engine, optionsWithFlag as HandlerOptions);
}
