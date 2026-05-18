import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Engine } from 'weft';
import { serve } from 'weft/server';
import { SQLiteStorage } from 'weft/storage/sqlite';

import { createOrderProcessingEngine, orderProcessingSchedule } from '../src/registry';

describe('order-processing server smoke check', () => {
  it('serves health and dashboard routes against SQLite storage', async () => {
    const dashboardModule = await import('../../../src/dashboard/index.html' as string);
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'weft-order-processing-smoke-'));

    try {
      using storage = new SQLiteStorage(join(temporaryDirectory, 'order-processing.sqlite'));
      await using engine = createOrderProcessingEngine(new Engine({ storage }));
      await engine.schedule(orderProcessingSchedule);

      await using server = serve({
        dashboard: dashboardModule.default,
        engine,
        hostname: '127.0.0.1',
        port: 0,
        publicOrigin: 'http://localhost',
      });

      const healthResponse = await fetch(new URL('/v1/health', server.url));
      expect(healthResponse.ok).toBe(true);

      const dashboardResponse = await fetch(new URL('/ui', server.url));
      expect(dashboardResponse.ok).toBe(true);
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
