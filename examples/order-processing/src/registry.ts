import { Engine, schedule } from 'weft';

import { releaseInventory, reserveInventory } from './activities/inventory';
import { chargePayment, refundPayment } from './activities/payment';
import { cancelStaleOrder, shipOrder } from './activities/shipping';
import { staleOrderSweepInput } from './sample-data';
import { orderWorkflow } from './workflows/order';
import { shipmentWorkflow } from './workflows/shipment';
import { sweepStaleOrdersWorkflow } from './workflows/sweep-stale';

export const orderProcessingSchedule = schedule({
  cron: '0 * * * *',
  id: 'order-processing-stale-order-sweep',
  input: staleOrderSweepInput,
  overlapPolicy: 'skip',
  workflow: sweepStaleOrdersWorkflow,
});

export function createOrderProcessingEngine<TEngine extends Engine>(engine: TEngine): TEngine {
  engine.register(reserveInventory);
  engine.register(releaseInventory);
  engine.register(chargePayment);
  engine.register(refundPayment);
  engine.register(cancelStaleOrder);
  engine.register(shipOrder);
  engine.register(orderWorkflow);
  engine.register(shipmentWorkflow);
  engine.register(sweepStaleOrdersWorkflow);
  return engine;
}
