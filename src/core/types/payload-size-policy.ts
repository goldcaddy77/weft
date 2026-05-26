// ---------------------------------------------------------------------------
// Payload-size cap policy
// ---------------------------------------------------------------------------

/**
 * Operator-configured upper bound on the serialized size of individual
 * payloads. Large payloads — workflow input, signal payloads, activity results
 * — are encoded into per-yield checkpoints and event-log entries, so an
 * oversized value inflates every durable write and is re-deserialized on every
 * replay. `maxBytes` caps the codec-boundary size (the exact byte length that
 * would be written) and rejects oversized payloads at admission, before any
 * storage write. Pass via {@link EngineOptions.payloadSize}.
 *
 * Thresholds are operator config only — there are no baked-in defaults. Omit
 * the policy (or `maxBytes`) to disable the cap entirely; when disabled, no
 * extra encode is performed, so the unconfigured path has zero added cost.
 *
 * @example
 * ```ts
 * import { Engine, type PayloadSizePolicy } from 'weft';
 *
 * const payloadSize: PayloadSizePolicy = { maxBytes: 1_048_576 };
 * const engine = new Engine({ payloadSize });
 * void engine;
 * ```
 */
export interface PayloadSizePolicy {
  /**
   * Maximum serialized (codec-encoded) byte length a single payload may have.
   * A payload whose encoded size is exactly `maxBytes` is allowed; one byte
   * larger is rejected with `PayloadSizeExceededError`. Must be a positive safe
   * integer. `0`, omitted, or `undefined` disables the cap.
   */
  maxBytes?: number;
}

/**
 * Payload-size policy after validation and normalisation. `maxBytes` is either
 * a positive safe integer (cap active) or `null` (disabled). Used internally by
 * the engine; callers configure via {@link PayloadSizePolicy}.
 */
export interface NormalizedPayloadSizePolicy {
  maxBytes: number | null;
}
