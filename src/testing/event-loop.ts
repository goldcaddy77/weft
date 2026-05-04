/** Let promise continuations and queued microtasks settle without advancing time. */
export async function flushPortableMicrotasks(turns = 3): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
}

/** Yield one event-loop turn without importing test-runner-only timer APIs. */
export async function yieldToPortableEventLoop(): Promise<void> {
  if (typeof MessageChannel !== 'undefined') {
    await new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      };
      channel.port2.postMessage(undefined);
    });
  } else {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  await flushPortableMicrotasks();
}
