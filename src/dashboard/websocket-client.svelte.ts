/**
 * WebSocket connection manager for real-time workflow observation.
 *
 * Opens a WebSocket per subscribed workflow and automatically
 * reconnects with exponential backoff on disconnect.
 *
 * @module dashboard/websocket-client
 */

import type { WorkflowEvent } from './api-client.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

interface Subscription {
  workflowId: string;
  callbacks: Set<(event: WorkflowEvent) => void>;
  socket: WebSocket | null;
  backoffMilliseconds: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  disposed: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INITIAL_BACKOFF_MILLISECONDS = 1_000;
const MAX_BACKOFF_MILLISECONDS = 30_000;
const BACKOFF_MULTIPLIER = 2;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildWebSocketUrl(workflowId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/v1/workflows/${encodeURIComponent(workflowId)}/watch`;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class WebSocketClient {
  #subscriptions = new Map<string, Subscription>();
  #connectionState: ConnectionState = $state('disconnected');

  /** The current aggregate connection state. */
  get connectionState(): ConnectionState {
    return this.#connectionState;
  }

  /**
   * Subscribe to real-time events for a workflow.
   * Returns an unsubscribe function.
   */
  subscribe(workflowId: string, callback: (event: WorkflowEvent) => void): () => void {
    let subscription = this.#subscriptions.get(workflowId);

    if (!subscription) {
      subscription = {
        workflowId,
        callbacks: new Set(),
        socket: null,
        backoffMilliseconds: INITIAL_BACKOFF_MILLISECONDS,
        reconnectTimer: null,
        disposed: false,
      };
      this.#subscriptions.set(workflowId, subscription);
      this.#connect(subscription);
    }

    subscription.callbacks.add(callback);

    return () => {
      subscription.callbacks.delete(callback);

      if (subscription.callbacks.size === 0) {
        this.#teardown(subscription);
        this.#subscriptions.delete(workflowId);
        this.#updateConnectionState();
      }
    };
  }

  /** Close all connections and clear all subscriptions. */
  dispose(): void {
    for (const subscription of this.#subscriptions.values()) {
      this.#teardown(subscription);
    }
    this.#subscriptions.clear();
    this.#connectionState = 'disconnected';
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  #connect(subscription: Subscription): void {
    if (subscription.disposed) return;

    this.#connectionState = 'connecting';

    const url = buildWebSocketUrl(subscription.workflowId);
    const socket = new WebSocket(url);
    subscription.socket = socket;

    socket.addEventListener('open', () => {
      if (subscription.disposed) {
        socket.close();
        return;
      }
      subscription.backoffMilliseconds = INITIAL_BACKOFF_MILLISECONDS;
      this.#updateConnectionState();
    });

    socket.addEventListener('message', (event) => {
      if (subscription.disposed) return;

      try {
        const parsed = JSON.parse(String(event.data)) as WorkflowEvent;
        for (const callback of subscription.callbacks) {
          callback(parsed);
        }
      } catch {
        // Ignore malformed messages
      }
    });

    socket.addEventListener('close', () => {
      if (subscription.disposed) return;
      subscription.socket = null;
      this.#updateConnectionState();
      this.#scheduleReconnect(subscription);
    });

    socket.addEventListener('error', () => {
      if (subscription.disposed) return;
      // The close event will fire after error; reconnect is handled there.
      socket.close();
    });
  }

  #scheduleReconnect(subscription: Subscription): void {
    if (subscription.disposed) return;

    const delay = subscription.backoffMilliseconds;
    subscription.backoffMilliseconds = Math.min(
      delay * BACKOFF_MULTIPLIER,
      MAX_BACKOFF_MILLISECONDS,
    );

    subscription.reconnectTimer = setTimeout(() => {
      subscription.reconnectTimer = null;
      this.#connect(subscription);
    }, delay);
  }

  #teardown(subscription: Subscription): void {
    subscription.disposed = true;

    if (subscription.reconnectTimer !== null) {
      clearTimeout(subscription.reconnectTimer);
      subscription.reconnectTimer = null;
    }

    if (subscription.socket !== null) {
      subscription.socket.close();
      subscription.socket = null;
    }
  }

  #updateConnectionState(): void {
    if (this.#subscriptions.size === 0) {
      this.#connectionState = 'disconnected';
      return;
    }

    let hasConnected = false;
    let hasConnecting = false;

    for (const subscription of this.#subscriptions.values()) {
      if (subscription.socket?.readyState === WebSocket.OPEN) {
        hasConnected = true;
      } else if (
        subscription.socket?.readyState === WebSocket.CONNECTING ||
        subscription.reconnectTimer !== null
      ) {
        hasConnecting = true;
      }
    }

    if (hasConnected) {
      this.#connectionState = 'connected';
    } else if (hasConnecting) {
      this.#connectionState = 'connecting';
    } else {
      this.#connectionState = 'disconnected';
    }
  }
}
