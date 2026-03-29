/**
 * Web Worker entry point for activity execution.
 *
 * Sets up `self.onmessage` to handle {@link ActivityExecutionRequest} and
 * posts back {@link ActivityExecutionResult} via `self.postMessage`. Uses
 * the existing `executeActivity` helper from `activity-runner.ts`.
 *
 * @module workers/activity-worker-entry
 */

import type { ActivityExecutionRequest, ActivityExecutionResult } from './activity-runner.ts';
import { executeActivity } from './activity-runner.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActivityHandlerLookup = (
  name: string,
) => ((...arguments_: unknown[]) => unknown) | undefined;

// ---------------------------------------------------------------------------
// Worker bootstrap
// ---------------------------------------------------------------------------

/**
 * Initialize the activity worker message loop. Call this from within a Web
 * Worker to wire up the activity execution protocol.
 *
 * @param getActivity - Resolves an activity name to its function. Typically
 *   backed by a registration map built at worker creation time.
 */
export function initializeActivityWorkerMessageLoop(getActivity: ActivityHandlerLookup): void {
  self.addEventListener('message', async (event: MessageEvent<ActivityExecutionRequest>) => {
    const request = event.data;
    const activityFunction = getActivity(request.activityName);

    if (!activityFunction) {
      const result: ActivityExecutionResult = {
        operationId: request.operationId,
        status: 'failed',
        error: `Unknown activity in worker: "${request.activityName}"`,
      };
      self.postMessage(result);
      return;
    }

    const result = await executeActivity(request, activityFunction);
    self.postMessage(result);
  });
}

// ---------------------------------------------------------------------------
// Function serialization validation
// ---------------------------------------------------------------------------

/**
 * Common patterns that indicate a function captures variables from an outer
 * scope and therefore cannot be safely serialized via `toString()`. When
 * detected, `validateHandlerSerializable` throws a descriptive error so
 * callers get an immediate, actionable failure instead of a silent broken
 * worker script.
 */
const CLOSURE_PATTERNS: ReadonlyArray<{ pattern: RegExp; description: string }> = [
  {
    pattern: /\bthis\b/,
    description: 'references `this` (class method or bound context)',
  },
  {
    pattern: /\bimport\s*\(/,
    description: 'uses dynamic `import()`',
  },
  {
    pattern: /\brequire\s*\(/,
    description: 'uses `require()`',
  },
];

/**
 * Strip string literals (single, double, template) and comments (line, block)
 * from JavaScript source so that closure-detection regexes only match actual
 * code, not occurrences inside `"use this link"` or `// import something`.
 */
function stripStringsAndComments(source: string): string {
  return source.replace(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:\\[\s\S]|[^`\\])*`|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g,
    '',
  );
}

/**
 * Validate that a handler function can be safely serialized with `toString()`
 * for use inside a Web Worker blob script.
 *
 * @throws {Error} If the function body matches a known closure pattern.
 */
function validateHandlerSerializable(
  name: string,
  handler: (...arguments_: unknown[]) => unknown,
): void {
  const source = handler.toString();

  // Native code cannot be serialized — `toString()` returns something like
  // `function foo() { [native code] }`.
  if (source.includes('[native code]')) {
    throw new Error(
      `Activity handler "${name}" is a native function and cannot be serialized for worker execution.`,
    );
  }

  // Strip strings and comments so patterns only match actual code references.
  const codeOnly = stripStringsAndComments(source);

  for (const { pattern, description } of CLOSURE_PATTERNS) {
    if (pattern.test(codeOnly)) {
      throw new Error(
        `Activity handler "${name}" ${description}. ` +
          'Handlers passed to createActivityWorkerEntryUrl must be self-contained functions ' +
          'without closures over outer scope, class instances, or module-level variables.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Blob URL creation
// ---------------------------------------------------------------------------

/** Return value of {@link createActivityWorkerEntryUrl}. */
export type ActivityWorkerEntryUrlResult = {
  /** The Blob URL to pass as `workerUrl` when constructing a {@link WorkerPool}. */
  url: string;
  /** Revoke the underlying Blob URL to free the URL registration. Call this
   *  once all workers that need the URL have been created (e.g., during
   *  engine disposal). */
  revoke: () => void;
};

/**
 * Create a Blob URL that can be used to spawn an activity Web Worker with
 * the given activity registrations.
 *
 * @param registrations - Map of activity names to handler functions. The
 *   handlers must be serializable (no closures over local state).
 * @returns An object containing the Blob URL and a `revoke` function that
 *   frees the underlying URL registration. Call `revoke()` once all workers
 *   that need the URL have been created.
 * @throws {Error} If any handler function cannot be safely serialized.
 */
export function createActivityWorkerEntryUrl(
  registrations: Map<string, (...arguments_: unknown[]) => unknown>,
): ActivityWorkerEntryUrlResult {
  for (const [name, handler] of registrations) {
    validateHandlerSerializable(name, handler);
  }

  const registrationEntries = [...registrations.entries()]
    .map(([name, handler]) => `  activities.set(${JSON.stringify(name)}, ${handler.toString()});`)
    .join('\n');

  const script = `
const activities = new Map();
${registrationEntries}

import { initializeActivityWorkerMessageLoop } from '${import.meta.url.replace(/activity-worker-entry\.[^/]+$/, 'activity-worker-entry.ts')}';
initializeActivityWorkerMessageLoop((name) => activities.get(name));
`;

  const blob = new Blob([script], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);

  return {
    url,
    revoke: () => URL.revokeObjectURL(url),
  };
}
