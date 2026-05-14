import { workflow, type WorkflowContext } from 'weft';

import type { SweepStaleOrdersInput, SweepStaleOrdersResult } from '../model';

export const sweepStaleOrdersWorkflow = workflow({
  name: 'orderProcessingSweepStaleOrders',
  handler: async function* orderProcessingSweepStaleOrders(
    context: WorkflowContext,
    input: SweepStaleOrdersInput,
  ): AsyncGenerator<unknown, SweepStaleOrdersResult, unknown> {
    yield* context.memo(`sweep:${input.now}`, () => input.staleOrderIds.length);
    const cancelledOrderResults = yield* context.all(
      input.staleOrderIds.map((orderId) =>
        context.run('orderProcessingCancelStaleOrder', {
          orderId,
          reason: 'stale-order-sweep',
        }),
      ),
    );
    return {
      cancelledOrderIds: cancelledOrderResults.filter(isString),
      scannedOrderCount: input.staleOrderIds.length,
    };
  },
});

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
