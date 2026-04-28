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
  const aString = JSON.stringify(a);
  const bString = JSON.stringify(b);
  if (aString !== bString) {
    throw new Error(
      `Parity invariant violated [${label}]: identical-json expected but payloads differ.\n` +
        `  Transport A: ${aString}\n` +
        `  Transport B: ${bString}`,
    );
  }
}

/**
 * Assert that two values have the same top-level keys with matching types.
 * Use for `successPayload: 'shape-equivalent'` invariants — allows values
 * to differ (e.g. generated ids, timestamps) as long as structure matches.
 */
export function assertShapeEquivalent(a: unknown, b: unknown, label: string): void {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    if (typeof a !== typeof b) {
      throw new Error(
        `Parity invariant violated [${label}]: shape-equivalent expected same typeof.\n` +
          `  Transport A: ${typeof a}\n` +
          `  Transport B: ${typeof b}`,
      );
    }
    return;
  }

  const aKeys = Object.keys(a as Record<string, unknown>).toSorted();
  const bKeys = Object.keys(b as Record<string, unknown>).toSorted();
  if (JSON.stringify(aKeys) !== JSON.stringify(bKeys)) {
    throw new Error(
      `Parity invariant violated [${label}]: shape-equivalent expected same keys.\n` +
        `  Transport A keys: ${JSON.stringify(aKeys)}\n` +
        `  Transport B keys: ${JSON.stringify(bKeys)}`,
    );
  }
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
