#!/usr/bin/env bun

export type ConformanceWrongActivitiesWorkerFixture = 'wrong-activities';

const serverUrl = Bun.env['WEFT_WORKER_URL'];

if (serverUrl === undefined) {
  console.error('WEFT_WORKER_URL is required');
  process.exit(2);
}

const socket = new WebSocket(serverUrl);

socket.addEventListener('open', () => {
  socket.send(
    JSON.stringify({
      type: 'register',
      protocolVersion: Number(Bun.env['WEFT_WORKER_PROTOCOL_VERSION'] ?? '1'),
      workerId: 'wrong-activities-worker',
      activities: ['weft.other.activity'],
      concurrency: 1,
      queue: Bun.env['WEFT_WORKER_QUEUE'] ?? 'conformance',
    }),
  );
});

socket.addEventListener('close', () => {
  process.exit(0);
});

socket.addEventListener('error', () => {
  process.exit(1);
});
