import { encode } from './codec.ts';
import { WeftError } from './weft-error.ts';

/**
 * The kind of payload being size-checked at the codec boundary. Used in the
 * {@link PayloadSizeExceededError} message so operators can tell which
 * admission point rejected the value.
 */
export type PayloadKind = 'workflow input' | 'signal payload' | 'activity result';

/**
 * Thrown at admission when a payload's serialized (codec-encoded) size exceeds
 * the operator-configured {@link PayloadSizePolicy.maxBytes}. The rejection
 * happens before any storage write, so no oversized value is ever persisted.
 *
 * This is a local validation error: its `code` is not part of the
 * cross-boundary `WeftErrorCode` union. Catch it with `instanceof` or by
 * comparing `error.code === 'PayloadSizeExceededError'`.
 *
 * @example
 * ```ts
 * import { workflow, Engine, PayloadSizeExceededError } from 'weft';
 *
 * const engine = new Engine({ payloadSize: { maxBytes: 64 } });
 * engine.register(workflow({ name: 'echo' }).execute(async function* (_ctx, input) { return input; }));
 *
 * try {
 *   await engine.start('echo', 'x'.repeat(1024));
 * } catch (err) {
 *   if (err instanceof PayloadSizeExceededError) {
 *     console.error(`${err.payloadKind} too large: ${String(err.serializedBytes)} > ${String(err.maxBytes)}`);
 *   }
 * }
 * ```
 */
export class PayloadSizeExceededError extends WeftError<'PayloadSizeExceededError'> {
  /** Which admission point rejected the payload. */
  readonly payloadKind: PayloadKind;
  /** The payload's actual serialized byte length. */
  readonly serializedBytes: number;
  /** The configured maximum serialized byte length. */
  readonly maxBytes: number;

  constructor(payloadKind: PayloadKind, serializedBytes: number, maxBytes: number) {
    super(
      'PayloadSizeExceededError',
      `${payloadKind} exceeds the configured maximum serialized size: ` +
        `${String(serializedBytes)} bytes > ${String(maxBytes)} byte limit.`,
    );
    this.payloadKind = payloadKind;
    this.serializedBytes = serializedBytes;
    this.maxBytes = maxBytes;
  }
}

/**
 * Reject a payload whose serialized size exceeds `limit`, before it is written.
 *
 * Size is measured as `encode(value).byteLength` — the exact bytes the storage
 * layer would persist. A payload exactly at `limit` is allowed; one byte larger
 * throws {@link PayloadSizeExceededError}. When `limit` is `null` the cap is
 * disabled and the function returns immediately without encoding, so the
 * unconfigured path costs nothing.
 *
 * @param value - The payload to measure.
 * @param limit - The maximum serialized byte length, or `null` to disable.
 * @param payloadKind - Which admission point is validating, for the error message.
 */
export function assertPayloadWithinLimit(
  value: unknown,
  limit: number | null,
  payloadKind: PayloadKind,
): void {
  if (limit === null) {
    return;
  }

  const serializedBytes = encode(value).byteLength;
  if (serializedBytes > limit) {
    throw new PayloadSizeExceededError(payloadKind, serializedBytes, limit);
  }
}
