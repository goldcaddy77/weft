import { Engine } from 'weft';
import { serve } from 'weft/server';
import { SQLiteStorage } from 'weft/storage/sqlite';

import { createOrderProcessingEngine, orderProcessingSchedule } from './registry';

const port = Number(Bun.env['PORT'] ?? 7321);
const hostname = Bun.env['HOST'] ?? '127.0.0.1';
const databasePath = Bun.env['WEFT_DATABASE_PATH'] ?? './order-processing.sqlite';

if (import.meta.main) {
  using storage = new SQLiteStorage(databasePath);
  await using engine = createOrderProcessingEngine(new Engine({ storage }));
  await engine.recoverAll({ acknowledgeUnknownWorkflowTypes: true });
  await engine.schedule(orderProcessingSchedule);

  await using server = serve({
    engine,
    hostname,
    port,
    publicOrigin: `http://localhost:${port}`,
  });

  console.log(`Order processing example listening at ${server.url}`);
  console.log(`Dashboard: ${server.url}ui`);

  await new Promise(() => {});
}
