import { workflow, type WorkflowContext } from 'weft';

import type { SweepStaleOrdersInput, SweepStaleOrdersResult } from '../model';

export const sweepStaleOrdersWorkflow = workflow({
  name: 'orderProcessingSweepStaleOrders',
  handler: async function* orderProcessingSweepStaleOrders(
    context: WorkflowContext,
    input: SweepStaleOrdersInput,
  ): AsyncGenerator<unknown, SweepStaleOrdersResult, unknown> {
    yield* context.memo(`sweep:${input.now}`, () => input.staleOrderIds.length);
    return {
      cancelledOrderIds: input.staleOrderIds,
      scannedOrderCount: input.staleOrderIds.length,
    };
  },
});
