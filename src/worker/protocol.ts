/* oxlint-disable max-lines -- ID:worker-protocol-contract-file-length */

/**
 * Canonical RemoteWorker WebSocket protocol contract.
 *
 * This module intentionally publishes plain JSON Schema objects instead of a
 * validator dependency. Non-TypeScript SDKs can vendor or consume the schemas,
 * while Weft's own runtime uses the type guards below at the trust boundary.
 *
 * @module worker/protocol
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

/**
 * JSON value carried over the worker protocol.
 *
 * @example
 * ```ts
 * import type { RemoteWorkerJsonValue } from 'weft/worker-protocol';
 *
 * const payload: RemoteWorkerJsonValue = { amount: 42, memo: null };
 * ```
 */
export type RemoteWorkerJsonValue =
  | null
  | boolean
  | number
  | string
  | RemoteWorkerJsonValue[]
  | { [key: string]: RemoteWorkerJsonValue };

/**
 * Worker registration message sent immediately after opening a worker stream.
 *
 * @example
 * ```ts
 * import type { RegisterMessage } from 'weft/worker-protocol';
 *
 * const message: RegisterMessage = {
 *   type: 'register',
 *   protocolVersion: 1,
 *   workerId: 'worker-1',
 *   activities: ['sendEmail'],
 * };
 * ```
 */
export type RegisterMessage = {
  readonly type: 'register';
  readonly protocolVersion: RemoteWorkerProtocolVersion;
  readonly workerId: string;
  readonly activities: readonly string[];
  readonly concurrency?: number;
  readonly queue?: string;
};

/**
 * Worker heartbeat message.
 *
 * @example
 * ```ts
 * import type { HeartbeatMessage } from 'weft/worker-protocol';
 *
 * const message: HeartbeatMessage = { type: 'heartbeat', workerId: 'worker-1' };
 * ```
 */
export type HeartbeatMessage = {
  readonly type: 'heartbeat';
  readonly workerId: string;
};

/**
 * Successful activity result message.
 *
 * @example
 * ```ts
 * import type { CompletedTaskResultMessage } from 'weft/worker-protocol';
 *
 * const message: CompletedTaskResultMessage = {
 *   type: 'taskResult',
 *   operationId: 'op-1',
 *   status: 'completed',
 *   value: null,
 * };
 * ```
 */
export type CompletedTaskResultMessage = {
  readonly type: 'taskResult';
  readonly operationId: string;
  readonly status: 'completed';
  readonly value: RemoteWorkerJsonValue;
};

/**
 * Failed activity result message.
 *
 * @example
 * ```ts
 * import type { FailedTaskResultMessage } from 'weft/worker-protocol';
 *
 * const message: FailedTaskResultMessage = {
 *   type: 'taskResult',
 *   operationId: 'op-1',
 *   status: 'failed',
 *   error: 'SMTP rejected the message',
 * };
 * ```
 */
export type FailedTaskResultMessage = {
  readonly type: 'taskResult';
  readonly operationId: string;
  readonly status: 'failed';
  readonly error: string;
};

/**
 * Cancelled activity result message.
 *
 * @example
 * ```ts
 * import type { CancelledTaskResultMessage } from 'weft/worker-protocol';
 *
 * const message: CancelledTaskResultMessage = {
 *   type: 'taskResult',
 *   operationId: 'op-1',
 *   status: 'cancelled',
 *   error: 'Task cancelled',
 *   cancelled: true,
 * };
 * ```
 */
export type CancelledTaskResultMessage = {
  readonly type: 'taskResult';
  readonly operationId: string;
  readonly status: 'cancelled';
  readonly error: string;
  readonly cancelled?: true;
};

/**
 * Worker-to-server task result message.
 *
 * @example
 * ```ts
 * import type { TaskResultMessage } from 'weft/worker-protocol';
 *
 * const message: TaskResultMessage = {
 *   type: 'taskResult',
 *   operationId: 'op-1',
 *   status: 'completed',
 *   value: { ok: true },
 * };
 * ```
 */
export type TaskResultMessage =
  | CompletedTaskResultMessage
  | FailedTaskResultMessage
  | CancelledTaskResultMessage;

/**
 * Messages accepted from a worker stream client.
 *
 * @example
 * ```ts
 * import type { WorkerToServerMessage } from 'weft/worker-protocol';
 *
 * const message: WorkerToServerMessage = { type: 'heartbeat', workerId: 'worker-1' };
 * ```
 */
export type WorkerToServerMessage = RegisterMessage | HeartbeatMessage | TaskResultMessage;

/**
 * Registration acknowledgement sent after a worker is accepted.
 *
 * @example
 * ```ts
 * import type { RegisterAckMessage } from 'weft/worker-protocol';
 *
 * const message: RegisterAckMessage = {
 *   type: 'registerAck',
 *   protocolVersion: 1,
 *   workerId: 'worker-1',
 *   queue: 'default',
 *   activities: ['sendEmail'],
 *   concurrency: 10,
 * };
 * ```
 */
export type RegisterAckMessage = {
  readonly type: 'registerAck';
  readonly protocolVersion: RemoteWorkerProtocolVersion;
  readonly workerId: string;
  readonly queue: string;
  readonly activities: readonly string[];
  readonly concurrency: number;
};

/**
 * Registration rejection sent before closing an unsupported worker stream.
 *
 * @example
 * ```ts
 * import type { RegisterErrorMessage } from 'weft/worker-protocol';
 *
 * const message: RegisterErrorMessage = {
 *   type: 'registerError',
 *   code: 'unsupported_protocol_version',
 *   message: 'Unsupported RemoteWorker protocol version: 2',
 *   supportedProtocolVersions: [1],
 *   requestedProtocolVersion: 2,
 * };
 * ```
 */
export type RegisterErrorMessage = {
  readonly type: 'registerError';
  readonly code: 'invalid_registration' | 'unsupported_protocol_version';
  readonly message: string;
  readonly supportedProtocolVersions: readonly RemoteWorkerProtocolVersion[];
  readonly requestedProtocolVersion?: number;
};

/**
 * Protocol-level error sent before closing a malformed worker stream.
 *
 * @example
 * ```ts
 * import type { ProtocolErrorMessage } from 'weft/worker-protocol';
 *
 * const message: ProtocolErrorMessage = {
 *   type: 'protocolError',
 *   code: 'invalid_message',
 *   message: 'taskResult.operationId must be a non-empty string',
 * };
 * ```
 */
export type ProtocolErrorMessage = {
  readonly type: 'protocolError';
  readonly code:
    | 'invalid_json'
    | 'invalid_message'
    | 'unknown_message_type'
    | 'registration_required';
  readonly message: string;
};

/**
 * Activity task dispatched by the server.
 *
 * @example
 * ```ts
 * import type { TaskMessage } from 'weft/worker-protocol';
 *
 * const message: TaskMessage = {
 *   type: 'task',
 *   operationId: 'op-1',
 *   activityName: 'sendEmail',
 *   input: { to: 'user@example.com' },
 * };
 * ```
 */
export type TaskMessage = {
  readonly type: 'task';
  readonly operationId: string;
  readonly activityName: string;
  readonly input: RemoteWorkerJsonValue;
  readonly attempt?: number;
  readonly headers?: Readonly<Record<string, string>>;
};

/**
 * Activity cancellation request sent by the server.
 *
 * @example
 * ```ts
 * import type { CancelMessage } from 'weft/worker-protocol';
 *
 * const message: CancelMessage = { type: 'cancel', operationId: 'op-1' };
 * ```
 */
export type CancelMessage = {
  readonly type: 'cancel';
  readonly operationId: string;
};

/**
 * Graceful worker shutdown request sent by the server.
 *
 * @example
 * ```ts
 * import type { ShutdownMessage } from 'weft/worker-protocol';
 *
 * const message: ShutdownMessage = { type: 'shutdown' };
 * ```
 */
export type ShutdownMessage = {
  readonly type: 'shutdown';
};

/**
 * Messages the server may send to a worker stream client.
 *
 * @example
 * ```ts
 * import type { ServerToWorkerMessage } from 'weft/worker-protocol';
 *
 * const message: ServerToWorkerMessage = { type: 'shutdown' };
 * ```
 */
export type ServerToWorkerMessage =
  | RegisterAckMessage
  | RegisterErrorMessage
  | ProtocolErrorMessage
  | TaskMessage
  | CancelMessage
  | ShutdownMessage;

/**
 * Protocol parse failure with a machine-readable code.
 *
 * @example
 * ```ts
 * import type { RemoteWorkerProtocolFailure } from 'weft/worker-protocol';
 *
 * const failure: RemoteWorkerProtocolFailure = {
 *   code: 'invalid_message',
 *   message: 'Protocol message must be an object',
 * };
 * ```
 */
export type RemoteWorkerProtocolFailure = {
  readonly code: ProtocolErrorMessage['code'] | RegisterErrorMessage['code'];
  readonly message: string;
  readonly requestedProtocolVersion?: number;
};

/**
 * Result returned by protocol parser helpers.
 *
 * @example
 * ```ts
 * import type { RemoteWorkerProtocolParseResult, RegisterMessage } from 'weft/worker-protocol';
 *
 * const result: RemoteWorkerProtocolParseResult<RegisterMessage> = {
 *   ok: false,
 *   error: { code: 'invalid_registration', message: 'workerId is required' },
 * };
 * ```
 */
export type RemoteWorkerProtocolParseResult<T> =
  | { readonly ok: true; readonly message: T }
  | { readonly ok: false; readonly error: RemoteWorkerProtocolFailure };

type JsonSchemaObject = {
  readonly [key: string]: unknown;
};

const jsonValueSchema: JsonSchemaObject = {
  $ref: '#/$defs/jsonValue',
};

const jsonObjectSchema: JsonSchemaObject = {
  type: 'object',
  additionalProperties: jsonValueSchema,
};

const stringMapSchema: JsonSchemaObject = {
  type: 'object',
  additionalProperties: { type: 'string' },
};

const protocolVersionSchema: JsonSchemaObject = {
  const: REMOTE_WORKER_PROTOCOL_VERSION,
};

/**
 * JSON Schema for every RemoteWorker protocol message, keyed by message type.
 *
 * @example
 * ```ts
 * import { REMOTE_WORKER_MESSAGE_SCHEMAS } from 'weft/worker-protocol';
 *
 * const registerSchema = REMOTE_WORKER_MESSAGE_SCHEMAS.register;
 * ```
 */
export const REMOTE_WORKER_MESSAGE_SCHEMAS = {
  register: {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'protocolVersion', 'workerId', 'activities'],
    properties: {
      type: { const: 'register' },
      protocolVersion: protocolVersionSchema,
      workerId: { type: 'string', minLength: 1 },
      activities: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
      },
      concurrency: { type: 'number', minimum: 1, maximum: 1000 },
      queue: { type: 'string', minLength: 1 },
    },
  },
  heartbeat: {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'workerId'],
    properties: {
      type: { const: 'heartbeat' },
      workerId: { type: 'string', minLength: 1 },
    },
  },
  taskResult: {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'operationId', 'status', 'value'],
        properties: {
          type: { const: 'taskResult' },
          operationId: { type: 'string', minLength: 1 },
          status: { const: 'completed' },
          value: jsonValueSchema,
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'operationId', 'status', 'error'],
        properties: {
          type: { const: 'taskResult' },
          operationId: { type: 'string', minLength: 1 },
          status: { const: 'failed' },
          error: { type: 'string' },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'operationId', 'status', 'error'],
        properties: {
          type: { const: 'taskResult' },
          operationId: { type: 'string', minLength: 1 },
          status: { const: 'cancelled' },
          error: { type: 'string' },
          cancelled: { const: true },
        },
      },
    ],
  },
  task: {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'operationId', 'activityName', 'input'],
    properties: {
      type: { const: 'task' },
      operationId: { type: 'string', minLength: 1 },
      activityName: { type: 'string', minLength: 1 },
      input: jsonValueSchema,
      attempt: { type: 'number', minimum: 1 },
      headers: stringMapSchema,
    },
  },
  cancel: {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'operationId'],
    properties: {
      type: { const: 'cancel' },
      operationId: { type: 'string', minLength: 1 },
    },
  },
  shutdown: {
    type: 'object',
    additionalProperties: false,
    required: ['type'],
    properties: {
      type: { const: 'shutdown' },
    },
  },
  registerAck: {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'protocolVersion', 'workerId', 'queue', 'activities', 'concurrency'],
    properties: {
      type: { const: 'registerAck' },
      protocolVersion: protocolVersionSchema,
      workerId: { type: 'string', minLength: 1 },
      queue: { type: 'string', minLength: 1 },
      activities: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
      },
      concurrency: { type: 'number', minimum: 1, maximum: 1000 },
    },
  },
  registerError: {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'code', 'message', 'supportedProtocolVersions'],
    properties: {
      type: { const: 'registerError' },
      code: { enum: ['invalid_registration', 'unsupported_protocol_version'] },
      message: { type: 'string' },
      supportedProtocolVersions: {
        type: 'array',
        items: protocolVersionSchema,
      },
      requestedProtocolVersion: { type: 'number' },
    },
  },
  protocolError: {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'code', 'message'],
    properties: {
      type: { const: 'protocolError' },
      code: {
        enum: ['invalid_json', 'invalid_message', 'unknown_message_type', 'registration_required'],
      },
      message: { type: 'string' },
    },
  },
} as const satisfies Record<string, JsonSchemaObject>;

/**
 * Complete RemoteWorker protocol JSON Schema document.
 *
 * @example
 * ```ts
 * import { REMOTE_WORKER_PROTOCOL_JSON_SCHEMA } from 'weft/worker-protocol';
 *
 * const schemaId = REMOTE_WORKER_PROTOCOL_JSON_SCHEMA.$id;
 * ```
 */
export const REMOTE_WORKER_PROTOCOL_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://weft.dev/schemas/remote-worker-protocol.v1.json',
  title: 'Weft RemoteWorker Protocol v1',
  oneOf: Object.keys(REMOTE_WORKER_MESSAGE_SCHEMAS).map((messageType) => ({
    $ref: `#/$defs/messages/${messageType}`,
  })),
  $defs: {
    jsonValue: {
      oneOf: [
        { type: 'null' },
        { type: 'boolean' },
        { type: 'number' },
        { type: 'string' },
        { type: 'array', items: { $ref: '#/$defs/jsonValue' } },
        {
          type: 'object',
          additionalProperties: { $ref: '#/$defs/jsonValue' },
        },
      ],
    },
    jsonObject: jsonObjectSchema,
    messages: REMOTE_WORKER_MESSAGE_SCHEMAS,
  },
} as const satisfies JsonSchemaObject;

const WORKER_TO_SERVER_TYPES = new Set(['register', 'heartbeat', 'taskResult']);
const SERVER_TO_WORKER_TYPES = new Set([
  'registerAck',
  'registerError',
  'protocolError',
  'task',
  'cancel',
  'shutdown',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Return true when a value can be represented by JSON on the worker protocol.
 *
 * @example
 * ```ts
 * import { isRemoteWorkerJsonValue } from 'weft/worker-protocol';
 *
 * const canSend = isRemoteWorkerJsonValue({ nested: ['ok'] });
 * ```
 */
export function isRemoteWorkerJsonValue(value: unknown): value is RemoteWorkerJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isRemoteWorkerJsonValue);
  }

  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every(isRemoteWorkerJsonValue);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'string');
}

function protocolFailure(
  code: RemoteWorkerProtocolFailure['code'],
  message: string,
  requestedProtocolVersion?: number,
): RemoteWorkerProtocolParseResult<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(requestedProtocolVersion !== undefined ? { requestedProtocolVersion } : {}),
    },
  };
}

// oxlint-disable-next-line complexity -- ID:worker-protocol-parse-register-message-complexity
function parseRegisterMessage(
  record: Record<string, unknown>,
): RemoteWorkerProtocolParseResult<RegisterMessage> {
  const protocolVersion = record['protocolVersion'];
  const requestedProtocolVersion =
    typeof protocolVersion === 'number' && Number.isFinite(protocolVersion)
      ? protocolVersion
      : undefined;
  if (protocolVersion !== REMOTE_WORKER_PROTOCOL_VERSION) {
    return protocolFailure(
      'unsupported_protocol_version',
      `Unsupported RemoteWorker protocol version: ${String(protocolVersion)}`,
      requestedProtocolVersion,
    );
  }

  const workerId = record['workerId'];
  if (!isNonEmptyString(workerId)) {
    return protocolFailure('invalid_registration', 'register.workerId must be a non-empty string');
  }

  const activities = record['activities'];
  if (!isStringArray(activities)) {
    return protocolFailure(
      'invalid_registration',
      'register.activities must be an array of non-empty strings',
    );
  }

  const concurrency = record['concurrency'];
  if (
    concurrency !== undefined &&
    (typeof concurrency !== 'number' || !Number.isFinite(concurrency))
  ) {
    return protocolFailure('invalid_registration', 'register.concurrency must be a finite number');
  }

  const queue = record['queue'];
  if (queue !== undefined && !isNonEmptyString(queue)) {
    return protocolFailure('invalid_registration', 'register.queue must be a non-empty string');
  }

  return {
    ok: true,
    message: {
      type: 'register',
      protocolVersion,
      workerId,
      activities,
      ...(concurrency !== undefined ? { concurrency } : {}),
      ...(queue !== undefined ? { queue } : {}),
    },
  };
}

function parseHeartbeatMessage(
  record: Record<string, unknown>,
): RemoteWorkerProtocolParseResult<HeartbeatMessage> {
  const workerId = record['workerId'];
  if (!isNonEmptyString(workerId)) {
    return protocolFailure('invalid_message', 'heartbeat.workerId must be a non-empty string');
  }

  return { ok: true, message: { type: 'heartbeat', workerId } };
}

// oxlint-disable-next-line complexity -- ID:worker-protocol-parse-task-result-message-complexity
function parseTaskResultMessage(
  record: Record<string, unknown>,
): RemoteWorkerProtocolParseResult<TaskResultMessage> {
  const operationId = record['operationId'];
  if (!isNonEmptyString(operationId)) {
    return protocolFailure('invalid_message', 'taskResult.operationId must be a non-empty string');
  }

  const status = record['status'];
  if (status === 'completed') {
    const value = record['value'];
    if (!isRemoteWorkerJsonValue(value)) {
      return protocolFailure('invalid_message', 'completed taskResult.value must be valid JSON');
    }
    return { ok: true, message: { type: 'taskResult', operationId, status, value } };
  }

  if (status === 'failed' || status === 'cancelled') {
    const error = record['error'];
    if (typeof error !== 'string') {
      return protocolFailure('invalid_message', `${status} taskResult.error must be a string`);
    }
    if (status === 'cancelled') {
      const cancelled = record['cancelled'];
      if (cancelled !== undefined && cancelled !== true) {
        return protocolFailure('invalid_message', 'taskResult.cancelled must be true when present');
      }
      return {
        ok: true,
        message: {
          type: 'taskResult',
          operationId,
          status,
          error,
          ...(cancelled === true ? { cancelled } : {}),
        },
      };
    }
    return { ok: true, message: { type: 'taskResult', operationId, status, error } };
  }

  return protocolFailure(
    'invalid_message',
    'taskResult.status must be completed, failed, or cancelled',
  );
}

// oxlint-disable-next-line complexity -- ID:worker-protocol-parse-task-message-complexity
function parseTaskMessage(
  record: Record<string, unknown>,
): RemoteWorkerProtocolParseResult<TaskMessage> {
  const operationId = record['operationId'];
  const activityName = record['activityName'];
  const input = record['input'];
  const attempt = record['attempt'];
  const headers = record['headers'];

  if (!isNonEmptyString(operationId)) {
    return protocolFailure('invalid_message', 'task.operationId must be a non-empty string');
  }
  if (!isNonEmptyString(activityName)) {
    return protocolFailure('invalid_message', 'task.activityName must be a non-empty string');
  }
  if (!isRemoteWorkerJsonValue(input)) {
    return protocolFailure('invalid_message', 'task.input must be valid JSON');
  }
  if (attempt !== undefined && (typeof attempt !== 'number' || !Number.isFinite(attempt))) {
    return protocolFailure('invalid_message', 'task.attempt must be a finite number');
  }
  if (headers !== undefined && !isStringRecord(headers)) {
    return protocolFailure('invalid_message', 'task.headers must be a string map');
  }

  return {
    ok: true,
    message: {
      type: 'task',
      operationId,
      activityName,
      input,
      ...(attempt !== undefined ? { attempt } : {}),
      ...(headers !== undefined ? { headers } : {}),
    },
  };
}

function parseCancelMessage(
  record: Record<string, unknown>,
): RemoteWorkerProtocolParseResult<CancelMessage> {
  const operationId = record['operationId'];
  if (!isNonEmptyString(operationId)) {
    return protocolFailure('invalid_message', 'cancel.operationId must be a non-empty string');
  }

  return { ok: true, message: { type: 'cancel', operationId } };
}

function parseShutdownMessage(): RemoteWorkerProtocolParseResult<ShutdownMessage> {
  return { ok: true, message: { type: 'shutdown' } };
}

function parseRegisterAckMessage(
  record: Record<string, unknown>,
): RemoteWorkerProtocolParseResult<RegisterAckMessage> {
  const protocolVersion = record['protocolVersion'];
  if (protocolVersion !== REMOTE_WORKER_PROTOCOL_VERSION) {
    return protocolFailure(
      'invalid_message',
      `registerAck.protocolVersion must be ${String(REMOTE_WORKER_PROTOCOL_VERSION)}`,
    );
  }

  const workerId = record['workerId'];
  const queue = record['queue'];
  const activities = record['activities'];
  const concurrency = record['concurrency'];
  if (!isNonEmptyString(workerId)) {
    return protocolFailure('invalid_message', 'registerAck.workerId must be a non-empty string');
  }
  if (!isNonEmptyString(queue)) {
    return protocolFailure('invalid_message', 'registerAck.queue must be a non-empty string');
  }
  if (!isStringArray(activities)) {
    return protocolFailure('invalid_message', 'registerAck.activities must be a string array');
  }
  if (typeof concurrency !== 'number' || !Number.isFinite(concurrency)) {
    return protocolFailure('invalid_message', 'registerAck.concurrency must be a finite number');
  }

  return {
    ok: true,
    message: { type: 'registerAck', protocolVersion, workerId, queue, activities, concurrency },
  };
}

function parseRegisterErrorMessage(
  record: Record<string, unknown>,
): RemoteWorkerProtocolParseResult<RegisterErrorMessage> {
  const code = record['code'];
  const message = record['message'];
  const supportedProtocolVersions = record['supportedProtocolVersions'];
  const requestedProtocolVersion = record['requestedProtocolVersion'];

  if (code !== 'invalid_registration' && code !== 'unsupported_protocol_version') {
    return protocolFailure('invalid_message', 'registerError.code is not recognized');
  }
  if (typeof message !== 'string') {
    return protocolFailure('invalid_message', 'registerError.message must be a string');
  }
  if (
    !Array.isArray(supportedProtocolVersions) ||
    !supportedProtocolVersions.every((version) => version === REMOTE_WORKER_PROTOCOL_VERSION)
  ) {
    return protocolFailure('invalid_message', 'registerError.supportedProtocolVersions is invalid');
  }
  if (
    requestedProtocolVersion !== undefined &&
    (typeof requestedProtocolVersion !== 'number' || !Number.isFinite(requestedProtocolVersion))
  ) {
    return protocolFailure(
      'invalid_message',
      'registerError.requestedProtocolVersion must be a finite number',
    );
  }

  return {
    ok: true,
    message: {
      type: 'registerError',
      code,
      message,
      supportedProtocolVersions,
      ...(requestedProtocolVersion !== undefined ? { requestedProtocolVersion } : {}),
    },
  };
}

function parseProtocolErrorMessage(
  record: Record<string, unknown>,
): RemoteWorkerProtocolParseResult<ProtocolErrorMessage> {
  const code = record['code'];
  const message = record['message'];
  if (
    code !== 'invalid_json' &&
    code !== 'invalid_message' &&
    code !== 'unknown_message_type' &&
    code !== 'registration_required'
  ) {
    return protocolFailure('invalid_message', 'protocolError.code is not recognized');
  }
  if (typeof message !== 'string') {
    return protocolFailure('invalid_message', 'protocolError.message must be a string');
  }

  return { ok: true, message: { type: 'protocolError', code, message } };
}

/**
 * Parse and validate a worker-to-server protocol message.
 *
 * @example
 * ```ts
 * import { parseWorkerToServerMessage } from 'weft/worker-protocol';
 *
 * const result = parseWorkerToServerMessage({ type: 'heartbeat', workerId: 'worker-1' });
 * ```
 */
export function parseWorkerToServerMessage(
  value: unknown,
): RemoteWorkerProtocolParseResult<WorkerToServerMessage> {
  if (!isRecord(value)) {
    return protocolFailure('invalid_message', 'Worker protocol message must be a JSON object');
  }

  const type = value['type'];
  if (typeof type !== 'string') {
    return protocolFailure('invalid_message', 'Worker protocol message.type must be a string');
  }
  if (!WORKER_TO_SERVER_TYPES.has(type)) {
    return protocolFailure('unknown_message_type', `Unknown worker message type: ${type}`);
  }

  switch (type) {
    case 'register':
      return parseRegisterMessage(value);
    case 'heartbeat':
      return parseHeartbeatMessage(value);
    case 'taskResult':
      return parseTaskResultMessage(value);
    default:
      return protocolFailure('unknown_message_type', `Unknown worker message type: ${type}`);
  }
}

/**
 * Parse and validate a server-to-worker protocol message.
 *
 * @example
 * ```ts
 * import { parseServerToWorkerMessage } from 'weft/worker-protocol';
 *
 * const result = parseServerToWorkerMessage({ type: 'shutdown' });
 * ```
 */
export function parseServerToWorkerMessage(
  value: unknown,
): RemoteWorkerProtocolParseResult<ServerToWorkerMessage> {
  if (!isRecord(value)) {
    return protocolFailure('invalid_message', 'Server protocol message must be a JSON object');
  }

  const type = value['type'];
  if (typeof type !== 'string') {
    return protocolFailure('invalid_message', 'Server protocol message.type must be a string');
  }
  if (!SERVER_TO_WORKER_TYPES.has(type)) {
    return protocolFailure('unknown_message_type', `Unknown server message type: ${type}`);
  }

  switch (type) {
    case 'registerAck':
      return parseRegisterAckMessage(value);
    case 'registerError':
      return parseRegisterErrorMessage(value);
    case 'protocolError':
      return parseProtocolErrorMessage(value);
    case 'task':
      return parseTaskMessage(value);
    case 'cancel':
      return parseCancelMessage(value);
    case 'shutdown':
      return parseShutdownMessage();
    default:
      return protocolFailure('unknown_message_type', `Unknown server message type: ${type}`);
  }
}
