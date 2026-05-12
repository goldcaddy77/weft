import type { Engine } from '../core/engine.ts';
import type { WeftEventMap } from '../core/events.ts';
import type { JsonRpcId } from '../server/json-rpc-protocol.ts';
import type { Principal } from '../server/principal.ts';
import { requestIdKey, type McpResponse } from './protocol.ts';

type NotificationTarget = (message: McpResponse | Record<string, unknown>) => void;

type PendingRequest = {
  readonly workflowId: string;
};

const RESOURCE_EVENT_NAMES = [
  'workflow:started',
  'workflow:completed',
  'workflow:failed',
  'workflow:cancelled',
  'workflow:timed-out',
  'workflow:resumed',
  'signal:received',
  'signal:delivered',
  'attributes:changed',
  'update:received',
  'update:completed',
] as const satisfies ReadonlyArray<keyof WeftEventMap>;

/**
 * Mutable MCP session state. Remote HTTP sessions are created during
 * `initialize`; stdio creates one local session for the process lifetime.
 *
 * @example
 * ```ts
 * import { McpSessionManager } from 'weft/mcp';
 * import { Engine, MemoryStorage } from 'weft';
 *
 * await using storage = new MemoryStorage();
 * await using engine = new Engine({ storage });
 * await using manager = new McpSessionManager(engine);
 *
 * const session = manager.create({ method: 'unauthenticated' });
 * session.notify('notifications/initialized');
 * ```
 */
export class McpSession {
  readonly id: string;
  readonly principal: Principal;
  initialized = false;
  protocolVersion = '2025-11-25';
  readonly subscriptions = new Set<string>();

  readonly #pendingRequests = new Map<string, PendingRequest>();
  readonly #targets = new Set<NotificationTarget>();

  constructor(id: string, principal: Principal) {
    this.id = id;
    this.principal = principal;
  }

  /** Track an in-flight request that started a workflow and can be cancelled. */
  trackRequest(requestId: unknown, workflowId: string): void {
    const key = requestIdKey(asJsonRpcId(requestId));
    if (key === undefined) return;
    this.#pendingRequests.set(key, { workflowId });
  }

  /** Stop tracking an in-flight request after it completes. */
  untrackRequest(requestId: unknown): void {
    const key = requestIdKey(asJsonRpcId(requestId));
    if (key === undefined) return;
    this.#pendingRequests.delete(key);
  }

  /** Return the workflow associated with an in-flight MCP request. */
  workflowForRequest(requestId: unknown): string | undefined {
    const key = requestIdKey(asJsonRpcId(requestId));
    if (key === undefined) return undefined;
    return this.#pendingRequests.get(key)?.workflowId;
  }

  /** Attach a notification sink. Returns a cleanup function. */
  addTarget(target: NotificationTarget): () => void {
    this.#targets.add(target);
    return () => {
      this.#targets.delete(target);
    };
  }

  /** Broadcast a JSON-RPC notification to every live stream for this session. */
  notify(method: string, params?: Record<string, unknown>): void {
    const message =
      params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params };
    for (const target of this.#targets) {
      target(message);
    }
  }

  close(): void {
    this.#pendingRequests.clear();
    this.subscriptions.clear();
    this.#targets.clear();
  }
}

function asJsonRpcId(value: unknown): JsonRpcId | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

/**
 * Owns MCP sessions for a running server and translates engine events into
 * resource update notifications.
 *
 * @example
 * ```ts
 * import { McpSessionManager } from 'weft/mcp';
 * import { Engine, MemoryStorage } from 'weft';
 *
 * await using storage = new MemoryStorage();
 * await using engine = new Engine({ storage });
 * await using manager = new McpSessionManager(engine);
 *
 * manager.closeAll();
 * ```
 */
export class McpSessionManager implements AsyncDisposable {
  readonly #engine: Engine;
  readonly #sessions = new Map<string, McpSession>();
  readonly #listener: EventListener;

  constructor(engine: Engine) {
    this.#engine = engine;
    this.#listener = (event) => {
      const workflowId = (event as { workflowId?: unknown }).workflowId;
      if (typeof workflowId !== 'string') return;
      this.#notifyWorkflowResourceUpdated(workflowId);
    };
    for (const eventName of RESOURCE_EVENT_NAMES) {
      this.#engine.addEventListener(eventName, this.#listener);
    }
  }

  /** Create and store a new session for a principal. */
  create(principal: Principal): McpSession {
    const session = new McpSession(crypto.randomUUID(), principal);
    this.#sessions.set(session.id, session);
    return session;
  }

  /** Store an externally-created session. Used by stdio. */
  add(session: McpSession): McpSession {
    this.#sessions.set(session.id, session);
    return session;
  }

  get(sessionId: string): McpSession | undefined {
    return this.#sessions.get(sessionId);
  }

  delete(sessionId: string): void {
    this.#sessions.get(sessionId)?.close();
    this.#sessions.delete(sessionId);
  }

  closeAll(): void {
    for (const session of this.#sessions.values()) {
      session.close();
    }
    this.#sessions.clear();
  }

  #notifyWorkflowResourceUpdated(workflowId: string): void {
    const candidateUris = [
      `weft://workflows/${workflowId}/state`,
      `weft://workflows/${workflowId}/events`,
      `weft://workflows/${workflowId}/checkpoints`,
    ];

    for (const session of this.#sessions.values()) {
      for (const uri of candidateUris) {
        if (!session.subscriptions.has(uri)) continue;
        session.notify('notifications/resources/updated', { uri });
      }
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const eventName of RESOURCE_EVENT_NAMES) {
      this.#engine.removeEventListener(eventName, this.#listener);
    }
    this.closeAll();
  }
}

/**
 * Create an MCP session manager for an engine.
 *
 * @example
 * ```ts
 * import { createMcpSessionManager } from 'weft/mcp';
 * import { Engine, MemoryStorage } from 'weft';
 *
 * await using storage = new MemoryStorage();
 * await using engine = new Engine({ storage });
 * await using manager = createMcpSessionManager(engine);
 *
 * void manager;
 * ```
 */
export function createMcpSessionManager(engine: Engine): McpSessionManager {
  return new McpSessionManager(engine);
}
