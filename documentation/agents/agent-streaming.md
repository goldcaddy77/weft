# Streaming

Your user is staring at a blank screen. The agent has been running for 12 seconds—three tool calls, two model turns—and there's nothing to show for it yet. That's the experience you get when streaming is an afterthought. In Weft, streaming is a first-class primitive: tokens flow to consumers in real time, multiple clients can subscribe to the same stream, and clients that disconnect can reconnect without missing content.

## TokenBridge

`TokenBridge` connects a `ReadableStream<StreamChunk>` to an `EventTarget`. As each token arrives from the LLM provider's stream, the bridge dispatches a `TokenEvent` so that local listeners—loggers, WebSocket forwarders, UI renderers—receive tokens as they're generated.

```typescript partial
import { TokenBridge } from 'weft';

const bridge = new TokenBridge(eventTarget, 'workflow-123', 'claude-sonnet-4-20250514');
```

The constructor takes three arguments: the `EventTarget` to dispatch events on, the workflow ID, and the model identifier. The `workflowId` and `model` are included in every `TokenEvent` so listeners can distinguish tokens from different workflows and models.

Pipe a stream through the bridge to start dispatching:

```typescript partial
const accumulatedText = await bridge.pipe(stream);
```

`pipe()` reads the stream to completion. For each chunk where `type === 'token'` and `token` is defined, it dispatches a `TokenEvent` and accumulates the text. The returned string is the full response text—useful for storing in conversation history or writing to a checkpoint.

The bridge is intentionally simple. It doesn't buffer, doesn't retry, doesn't manage backpressure—it's a single-purpose connector between a `ReadableStream` and an `EventTarget`. Compose it with the other streaming primitives for more complex setups.

## StreamMultiplexer

When multiple consumers need the same stream—say, a checkpoint accumulator, an EventTarget bridge, and a set of WebSocket subscribers—you don't want to duplicate the LLM API call. `StreamMultiplexer` fans out a single source stream to any number of consumers.

```typescript partial
import { StreamMultiplexer } from 'weft';

const multiplexer = new StreamMultiplexer(sourceStream, {
  maxBufferSize: 1000,
});
```

The `maxBufferSize` option (defaults to 1000) controls how many chunks are buffered for late-joining consumers. Once the buffer exceeds this size, the oldest chunks are dropped.

Create consumer streams:

```typescript partial
const checkpointStream = multiplexer.createConsumer();
const observerStream = multiplexer.createConsumer();
```

Each consumer is an independent `ReadableStream<StreamChunk>`. The multiplexer starts reading from the source when the first consumer is created. Late consumers receive all buffered chunks immediately upon creation, then live chunks going forward. If the source has already finished by the time a consumer is created, the consumer gets the full buffer and closes.

Check how many consumers are active:

```typescript partial
console.log(multiplexer.consumerCount); // 2
```

Cancel the entire multiplexer to close all consumers and release the source:

```typescript partial
multiplexer.cancel();
```

A practical setup might look like this:

```typescript partial
const multiplexer = new StreamMultiplexer(llmStream);

// Consumer 1: accumulate text for the checkpoint
const checkpointConsumer = multiplexer.createConsumer();
const turnText = accumulateText(checkpointConsumer);

// Consumer 2: bridge to EventTarget for local listeners
const eventConsumer = multiplexer.createConsumer();
const bridge = new TokenBridge(eventTarget, workflowId, model);
bridge.pipe(eventConsumer);

// Consumer 3: late-joining WebSocket client (gets buffered chunks + live)
websocket.onConnection(() => {
  const wsConsumer = multiplexer.createConsumer();
  pipeToWebSocket(wsConsumer, websocket);
});
```

## ReconnectionBuffer

When a client disconnects mid-stream and reconnects (browser tab refresh, network blip, mobile switch from Wi-Fi to cellular), it needs to catch up on what it missed. `ReconnectionBuffer` accumulates completed turn text for exactly this purpose.

```typescript
import { ReconnectionBuffer } from 'weft';

const buffer = new ReconnectionBuffer({ maxTurns: 10 });
```

The `maxTurns` option (defaults to 10) caps how many turns are kept. Once the buffer exceeds this, the oldest turn is dropped. A `maxBytes` option (default 10 MB) caps the total byte budget; turns are evicted oldest-first by count first, then by byte budget—always keeping at least one turn so a single oversized response doesn't wipe the buffer.

Record completed turns as they finish:

```typescript partial
buffer.addTurn('The research indicates three key findings...');
buffer.addTurn('Based on the analysis, I recommend...');
```

When a client reconnects, replay the buffer:

```typescript partial
const turns = buffer.getTurns(); // string[]
for (const turn of turns) {
  websocket.send(JSON.stringify({ type: 'replay', content: turn }));
}
// Then switch to live streaming for the current turn
```

Check the buffer state or clear it:

```typescript partial
console.log(buffer.turnCount); // 2
console.log(buffer.byteSize); // approximate byte size of buffered turns
buffer.clear();
```

## Crash recovery mid-stream

When a process crashes while tokens are streaming, the engine resumes from the last completed tool call or turn boundary—not from the beginning of the agent loop. The partial token output from the interrupted turn is discarded, and the LLM call is re-issued for that turn only.

Clients that reconnect receive the accumulated output from prior turns via the reconnection buffer, then start receiving live tokens from the retried turn. From the user's perspective, there's a brief pause and then streaming continues—no duplicate content, no lost context.

The text generated so far in completed turns is included in the checkpoint state. On recovery, the engine knows exactly what has been streamed to clients, enabling seamless replay without re-requesting completed content from the LLM.

## Backpressure

`ReadableStream`'s built-in backpressure mechanism propagates from slow consumers. If a WebSocket client can't keep up, the stream's `desiredSize` on the controller drops to zero, signaling the producer to slow down.

There is no engine-level streaming config—backpressure limits are set per-instance. Pass `maxBufferSize` to `StreamMultiplexer` to cap how many chunks are buffered for late-joining consumers. For completed-turn replay, pass `maxBytes` alongside `maxTurns` to `ReconnectionBuffer`:

```typescript partial
const multiplexer = new StreamMultiplexer(llmStream, {
  maxBufferSize: 1000, // max chunks buffered per consumer
});

const buffer = new ReconnectionBuffer({
  maxTurns: 10,
  maxBytes: 1_048_576, // 1 MB byte budget
});
```

This is standard Web Streams API behavior—no custom protocols, no polling, no heartbeat timers. The platform handles it.

Streaming in agent workflows isn't optional—it's the difference between a usable product and a loading spinner. These three primitives (`TokenBridge`, `StreamMultiplexer`, `ReconnectionBuffer`) give you the building blocks, and the engine wires them together automatically for `executeAgentLoop()` calls.
