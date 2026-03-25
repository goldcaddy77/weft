# Browser Runtime

Weft runs in the browser. Not a stripped-down client library that talks to a server---the actual engine, executing workflows in Web Workers, persisting state to IndexedDB, all inside the browser.

The key enabler is the Service Worker.

## Service Worker as the browser server

A Service Worker is a special kind of Web Worker that acts as a proxy between your web app and the network. It intercepts `fetch` events, can cache responses, and crucially---it runs in the background even when the tab is closed. It has access to IndexedDB for persistent storage and scheduling primitives for periodic wakeup.

For Weft, a Service Worker is the browser equivalent of the Bun server process.

```
┌──────────────────────────────────────────────────────┐
│ Browser Tab (your app)                               │
│                                                      │
│  const weft = new WeftClient();                      │
│  await weft.start("order", { orderId: "abc" });      │
│                                                      │
│  // This fetch() is intercepted by the Service Worker│
│  fetch("/weft/v1/workflows", { method: "POST", ... })│
└──────────────────┬───────────────────────────────────┘
                   │ fetch event
┌──────────────────▼───────────────────────────────────┐
│ Service Worker (weft-sw.ts)                          │
│                                                      │
│  self.addEventListener("fetch", (event) => {         │
│    if (event.request.url.includes("/weft/")) {       │
│      event.respondWith(engine.handleRequest(event)); │
│    }                                                 │
│  });                                                 │
│                                                      │
│  Engine(IndexedDBStorage) ← same engine code!        │
│                                                      │
│  // Durable timers via IndexedDB + periodic check    │
│  // Workflow execution in spawned Web Workers         │
│  // Survives tab close (Service Worker lifecycle)     │
└──────────────────────────────────────────────────────┘
```

## Same handleRequest, different environment

The Weft HTTP handler is a pure `Request` to `Response` function. On the server, `Bun.serve()` calls it. In the browser, the Service Worker's `fetch` event calls it. Same function, same API surface.

```typescript
// weft-sw.ts — installed as a Service Worker
/// <reference lib="webworker" />

import { Engine } from 'weft/core';
import { IndexedDBStorage } from 'weft/storage/indexeddb';
import { handleHTTP } from 'weft/server/handler';

const engine = new Engine({
  storage: new IndexedDBStorage('weft'),
});

self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/weft/')) {
    event.respondWith(handleHTTP(engine, event.request));
  }
});
```

The client library doesn't know or care whether its `fetch` calls hit a remote server or a local Service Worker. The API contract is identical.

## Durable timers with Periodic Background Sync

Workflows need timers---`yield* ctx.sleep("1 hour")` has to actually wake up an hour later. In Bun, the scheduler polls the database. In the browser, the **Periodic Background Sync API** serves the same purpose.

```typescript
self.addEventListener('periodicsync', (event: PeriodicSyncEvent) => {
  if (event.tag === 'weft-timers') {
    event.waitUntil(engine.processExpiredTimers());
  }
});
```

The browser periodically wakes the Service Worker, which checks IndexedDB for expired timers and advances any waiting workflows.

## What this enables

**Offline-first durable workflows.** An app starts a workflow (say, "sync these photos when online"). The Service Worker persists the workflow to IndexedDB. Even if the user closes the tab, the Service Worker resumes when the browser wakes it up.

**Same API surface.** The Weft client library calls `fetch("/weft/v1/workflows", ...)`. In server mode, this goes over the network to a Weft server. In browser mode, the Service Worker intercepts it. Your client code doesn't change.

**Hybrid mode.** The Service Worker can act as a local cache and queue that syncs with a remote Weft server. Start workflows locally for immediate responsiveness, sync state to the server when connectivity allows.

## Limitations

Service Workers don't have unlimited background execution time. Browsers limit how long a Service Worker can run after the page is closed. The Periodic Background Sync API's minimum interval varies by browser and depends on site engagement heuristics.

For truly long-running workflows---ones that need to execute for hours or days---you still need a server. The browser runtime is ideal for: queuing work, short workflows, offline caching, and syncing state with a remote Weft server.

The important thing is that these aren't two different engines with a compatibility layer between them. It's the same engine, the same workflow code, the same storage interface. The browser runtime is a deployment target, not a separate product.
