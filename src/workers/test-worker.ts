/* eslint-disable unicorn/prefer-add-event-listener, unicorn/require-post-message-target-origin */
/// <reference lib="webworker" />
self.onmessage = (event: MessageEvent) => {
  self.postMessage({ echo: event.data });
};
