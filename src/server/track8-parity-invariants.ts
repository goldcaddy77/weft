/**
 * Track 8 parity invariant definitions and assertion helpers.
 *
 * These types and functions let tests express that an operation behaves
 * identically across REST, JSON-RPC HTTP, JSON-RPC WebSocket, and JSON-RPC
 * stdio transports. The invariants are checked per operation class.
 *
 * @module server/track8-parity-invariants
 */

export type ParityInvariants = {
  /** Success payloads are identical JSON vs. shape-equivalent (allows id/timestamp variance). */
  successPayload: 'identical-json' | 'shape-equivalent';
  /** Same engine fault → same fault code on every transport. */
  errorMapping: 'one-to-one';
  /** Same principal + scope → same access decision on every transport. */
  authBehavior: 'identical';
  /** Engine method is invoked exactly once per call (no double-dispatch). */
  sideEffects: 'invoked-once-per-call';
};

/**
 * Assert that two JSON values are identical by deep equality.
 * Use for `successPayload: 'identical-json'` invariants.
 */
export function assertIdenticalJson(a: unknown, b: unknown, label: string): void {
  const aString = sortedJson(a);
  const bString = sortedJson(b);
  if (aString !== bString) {
    throw new Error(
      `Parity invariant violated [${label}]: identical-json expected but payloads differ.\n` +
        `  Transport A: ${aString}\n` +
        `  Transport B: ${bString}`,
    );
  }
}

/**
 * Assert that two values have the same recursive key shape with matching types.
 * Use for `successPayload: 'shape-equivalent'` invariants — allows values
 * to differ (e.g. generated ids, timestamps) as long as structure matches.
 */
export function assertShapeEquivalent(a: unknown, b: unknown, label: string): void {
  checkShapeRecursive(a, b, label);
}

/**
 * Assert that two fault codes are identical.
 * Use for `errorMapping: 'one-to-one'` invariants.
 */
export function assertIdenticalFaultCode(aCode: string, bCode: string, label: string): void {
  if (aCode !== bCode) {
    throw new Error(
      `Parity invariant violated [${label}]: errorMapping one-to-one expected same fault code.\n` +
        `  Transport A code: ${aCode}\n` +
        `  Transport B code: ${bCode}`,
    );
  }
}

function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_, currentValue: unknown) =>
    currentValue !== null && typeof currentValue === 'object' && !Array.isArray(currentValue)
      ? Object.fromEntries(
          Object.entries(currentValue as Record<string, unknown>).toSorted(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : currentValue,
  );
}

function checkShapeRecursive(a: unknown, b: unknown, path: string): void {
  if (typeof a !== typeof b) {
    throw new Error(
      `Parity invariant violated: shape-equivalent expected same typeof at path "${path}".\n` +
        `  A: ${typeof a}\n` +
        `  B: ${typeof b}`,
    );
  }
  if (typeof a !== 'object' || a === null || b === null) return;

  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord).toSorted();
  const bKeys = Object.keys(bRecord).toSorted();
  if (JSON.stringify(aKeys) !== JSON.stringify(bKeys)) {
    throw new Error(
      `Parity invariant violated: shape-equivalent expected same keys at path "${path}".\n` +
        `  A keys: ${JSON.stringify(aKeys)}\n` +
        `  B keys: ${JSON.stringify(bKeys)}`,
    );
  }
  for (const key of aKeys) {
    checkShapeRecursive(aRecord[key], bRecord[key], `${path}.${key}`);
  }
}
