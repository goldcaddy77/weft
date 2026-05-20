/**
 * Canonical RemoteWorker wire protocol version constants.
 *
 * Lives in a leaf module so both the parser implementation (`protocol.ts`) and
 * the JSON Schema declarations (`protocol-schemas.ts`) can depend on the
 * version without forming an import cycle.
 *
 * @module worker/protocol-version
 */

/**
 * Current RemoteWorker wire protocol version.
 *
 * @example
 * ```ts
 * import { REMOTE_WORKER_PROTOCOL_VERSION } from 'weft/worker-protocol';
 *
 * const registration = { type: 'register', protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION };
 * ```
 */
export const REMOTE_WORKER_PROTOCOL_VERSION = 1;

/**
 * Lowest RemoteWorker protocol version accepted by this package.
 *
 * @example
 * ```ts
 * import { REMOTE_WORKER_MIN_PROTOCOL_VERSION } from 'weft/worker-protocol';
 *
 * const supportsVersionOne = REMOTE_WORKER_MIN_PROTOCOL_VERSION === 1;
 * ```
 */
export const REMOTE_WORKER_MIN_PROTOCOL_VERSION = 1;

/**
 * Highest RemoteWorker protocol version accepted by this package.
 *
 * @example
 * ```ts
 * import { REMOTE_WORKER_MAX_PROTOCOL_VERSION } from 'weft/worker-protocol';
 *
 * const canUseRequestedVersion = 1 <= REMOTE_WORKER_MAX_PROTOCOL_VERSION;
 * ```
 */
export const REMOTE_WORKER_MAX_PROTOCOL_VERSION = 1;

/**
 * Explicit supported RemoteWorker protocol versions.
 *
 * @example
 * ```ts
 * import { REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS } from 'weft/worker-protocol';
 *
 * const supported = REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS.includes(1);
 * ```
 */
export const REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS = [REMOTE_WORKER_PROTOCOL_VERSION] as const;

/**
 * RemoteWorker protocol version accepted by this package.
 *
 * @example
 * ```ts
 * import type { RemoteWorkerProtocolVersion } from 'weft/worker-protocol';
 *
 * const version: RemoteWorkerProtocolVersion = 1;
 * ```
 */
export type RemoteWorkerProtocolVersion =
  (typeof REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS)[number];
