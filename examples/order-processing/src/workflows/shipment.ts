import { workflow, type WorkflowContext } from 'weft';

import { shipOrder } from '../activities/shipping';
import type { ShipmentInput, ShipmentResult } from '../model';

export const shipmentWorkflow = workflow({
  name: 'orderProcessingShipment',
  handler: async function* orderProcessingShipment(
    context: WorkflowContext,
    input: ShipmentInput,
  ): AsyncGenerator<unknown, ShipmentResult, unknown> {
    return yield* context.run(shipOrder, input);
  },
});
