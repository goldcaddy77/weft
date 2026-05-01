import type { ServerWebSocket } from 'bun';

import type { Engine } from '../../core/engine.ts';
import { TokenEvent } from '../../core/events.ts';
import { KEYS } from '../../storage/interface.ts';
import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';
import type { ServerContext } from './context.ts';

export function sendStreamMessage(
  ws: ServerWebSocket<WebSocketData>,
  sequence: number,
  message: string,
): void {
  if (sequence <= (ws.data.lastDeliveredSequence ?? -1)) {
    return;
  }

  ws.send(message);
  ws.data.lastDeliveredSequence = sequence;
}

export async function getHighestStoredStreamSequence(
  engine: Engine,
  workflowId: string,
  key: string,
): Promise<number> {
  const prefix = KEYS.streamChunkPrefix(workflowId, key);

  for await (const [storageKey] of engine.storage.scan(prefix, { reverse: true, limit: 1 })) {
    const sequenceText = storageKey.slice(prefix.length);
    const sequence = Number.parseInt(sequenceText, 10);
    if (Number.isSafeInteger(sequence) && sequence >= 0) {
      return sequence;
    }
  }

  return -1;
}

export function addStreamSocket(
  context: ServerContext,
  workflowId: string,
  ws: ServerWebSocket<WebSocketData>,
): void {
  let sockets = context.streamSockets.get(workflowId);
  if (!sockets) {
    sockets = new Set();
    context.streamSockets.set(workflowId, sockets);
  }
  sockets.add(ws);
}

export function removeStreamSocket(
  context: ServerContext,
  ws: ServerWebSocket<WebSocketData>,
): void {
  const workflowId = ws.data.workflowId;
  if (!workflowId) return;

  const sockets = context.streamSockets.get(workflowId);
  if (!sockets) return;

  sockets.delete(ws);
  if (sockets.size === 0) {
    context.streamSockets.delete(workflowId);
  }
}

export function flushPendingStreamMessages(
  _context: ServerContext,
  ws: ServerWebSocket<WebSocketData>,
): void {
  const pendingMessages = ws.data.pendingStreamMessages ?? [];
  pendingMessages.sort((left, right) => left.sequence - right.sequence);

  for (const pending of pendingMessages) {
    sendStreamMessage(ws, pending.sequence, pending.message);
  }

  ws.data.pendingStreamMessages = [];
}

export function publishTokenMessage(
  context: ServerContext,
  workflowId: string,
  sequence: number,
  message: string,
): void {
  const sockets = context.streamSockets.get(workflowId);
  if (!sockets) return;

  for (const ws of sockets) {
    if (ws.data.replayInProgress) {
      ws.data.pendingStreamMessages ??= [];
      ws.data.pendingStreamMessages.push({ sequence, message });
      continue;
    }

    sendStreamMessage(ws, sequence, message);
  }
}

/**
 * Send existing token chunks from storage to a newly connected stream client,
 * so it can catch up on tokens emitted before the connection was established.
 */
export async function replayTokenStream(
  context: ServerContext,
  engine: Engine,
  ws: ServerWebSocket<WebSocketData>,
  workflowId: string,
): Promise<void> {
  ws.data.lastDeliveredSequence = -1;

  try {
    const requestedResumeFrom = ws.data.resumeFrom;
    const after =
      requestedResumeFrom === undefined
        ? -1
        : Math.min(
            requestedResumeFrom,
            await getHighestStoredStreamSequence(engine, workflowId, 'tokens'),
          );
    ws.data.lastDeliveredSequence = after;
    const chunks =
      after >= 0
        ? await engine.getStreamChunks(workflowId, 'tokens', { after })
        : await engine.getStreamChunks(workflowId, 'tokens');

    for (const chunk of chunks) {
      if (typeof chunk.value !== 'object' || chunk.value === null) {
        continue;
      }

      sendStreamMessage(
        ws,
        chunk.sequence,
        JSON.stringify({
          type: TokenEvent.type,
          timestamp: Date.now(),
          sequence: chunk.sequence,
          data: chunk.value,
        }),
      );
    }
  } catch (error) {
    console.error(`[weft] Failed to replay token stream for workflow "${workflowId}":`, error);
  } finally {
    ws.data.replayInProgress = false;
    flushPendingStreamMessages(context, ws);
  }
}
