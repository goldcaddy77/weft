import { workflow, type WorkflowContext } from 'weft';

import { cancelStaleOrder } from '../activities/shipping';
import type { SweepStaleOrdersInput, SweepStaleOrdersResult } from '../model';

export const sweepStaleOrdersWorkflow = workflow({
  name: 'orderProcessingSweepStaleOrders',
  handler: async function* orderProcessingSweepStaleOrders(
    context: WorkflowContext,
    input: SweepStaleOrdersInput,
  ): AsyncGenerator<unknown, SweepStaleOrdersResult, unknown> {
    yield* context.memo(`sweep:${input.now}`, () => input.staleOrderIds.length);
    const cancelledOrderIds = yield* context.all(
      input.staleOrderIds.map((orderId) =>
        context.run(cancelStaleOrder, {
          orderId,
          reason: 'stale-order-sweep',
        }),
      ),
    );
    return {
      cancelledOrderIds,
      scannedOrderCount: input.staleOrderIds.length,
    };
  },
});
