/**
 * Shared JSON-RPC-over-WebSocket test helpers.
 *
 * The sequence-cursor and acceptance suites both open an authenticated
 * WebSocket against `/jsonrpc`, subscribe to a workflow's event stream, and
 * collect the delivered envelopes in order. This module is the single source
 * of truth for that flow so the two suites stay in lockstep instead of each
 * carrying a near-identical copy.
 *
 * Consumed via deep import and intentionally not re-exported from any package
 * entry point — it is test infrastructure, not public surface. The
 * `.test-support.ts` suffix is excluded by `tsconfig.build.json` so this file
 * never ships in `dist/`.
 */

import type { WeftServer } from './index.ts';
import type { EventEnvelope } from './workflow-event-feed.ts';

/**
 * Opens a WebSocket to `url`. When `apiKey` is provided it is presented as a
 * Bearer token; otherwise the socket connects without an Authorization header.
 *
 * Bun's WebSocket constructor accepts a `headers` option that the DOM lib type
 * omits, and the package-root typecheck uses the DOM lib. `Reflect.construct`
 * passes the extra option without tripping that narrower constructor type.
 */
export function openWebSocket(url: string, apiKey?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const webSocket: WebSocket =
      apiKey === undefined
        ? new WebSocket(url)
        : Reflect.construct(WebSocket, [url, { headers: { authorization: `Bearer ${apiKey}` } }]);
    webSocket.addEventListener('open', () => resolve(webSocket));
    webSocket.addEventListener('error', (event) => reject(event));
  });
}

/**
 * Subscribes to a workflow's event stream over an authenticated WebSocket and
 * resolves with the delivered envelopes once `expectedCount` have arrived.
 *
 * `correlationPrefix` distinguishes the subscribe request id so concurrent
 * suites do not collide on the same correlation id.
 */
export async function collectWebSocketDeliveredEnvelopes(
  server: WeftServer,
  workflowId: string,
  expectedCount: number,
  apiKey: string,
  correlationPrefix = 'collect',
): Promise<EventEnvelope[]> {
  const webSocketUrl = `${server.url.replace('http://', 'ws://')}/jsonrpc`;
  const webSocket = await openWebSocket(webSocketUrl, apiKey);

  try {
    return await new Promise<EventEnvelope[]>((resolve, reject) => {
      const received: EventEnvelope[] = [];
      const correlationId = `${correlationPrefix}-${workflowId}`;
      let subscriptionId: string | undefined;

      const timer = setTimeout(() => {
        webSocket.removeEventListener('message', handler);
        reject(new Error('collectWebSocketDeliveredEnvelopes timed out'));
      }, 3_000);

      function finish(value: EventEnvelope[]): void {
        clearTimeout(timer);
        webSocket.removeEventListener('message', handler);
        resolve(value);
      }

      function handler(event: MessageEvent): void {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (typeof parsed !== 'object' || parsed === null) {
          return;
        }

        const record = parsed as Record<string, unknown>;
        if (record['id'] === correlationId) {
          const result = record['result'];
          if (typeof result === 'object' && result !== null) {
            const candidateSubscriptionId = (result as Record<string, unknown>)['subscriptionId'];
            if (typeof candidateSubscriptionId === 'string') {
              subscriptionId = candidateSubscriptionId;
              if (expectedCount === 0) {
                finish([]);
              }
            }
          }
          return;
        }

        if (record['method'] !== 'weft.events.deliver' || subscriptionId === undefined) {
          return;
        }

        const params = record['params'];
        if (typeof params !== 'object' || params === null) {
          return;
        }

        const deliverParams = params as Record<string, unknown>;
        if (deliverParams['subscriptionId'] !== subscriptionId) {
          return;
        }

        const envelope = deliverParams['envelope'];
        if (typeof envelope !== 'object' || envelope === null) {
          return;
        }

        received.push(envelope as EventEnvelope);
        if (received.length >= expectedCount) {
          finish(received);
        }
      }

      webSocket.addEventListener('message', handler);
      webSocket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: correlationId,
          method: 'weft.workflows.subscribe',
          params: { workflowId, selector: 'events' },
        }),
      );
    });
  } finally {
    webSocket.close();
  }
}

/**
 * Resolves with the first parsed WebSocket message that satisfies `predicate`,
 * or rejects after `timeoutMs`. Used to await a single JSON-RPC response on a
 * shared socket.
 */
export function waitForWebSocketMessage(
  webSocket: WebSocket,
  predicate: (parsed: unknown) => boolean,
  timeoutMs = 3_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      webSocket.removeEventListener('message', handler);
      reject(new Error('waitForWebSocketMessage timed out'));
    }, timeoutMs);

    function handler(event: MessageEvent): void {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (predicate(parsed)) {
        clearTimeout(timer);
        webSocket.removeEventListener('message', handler);
        resolve(parsed);
      }
    }

    webSocket.addEventListener('message', handler);
  });
}
