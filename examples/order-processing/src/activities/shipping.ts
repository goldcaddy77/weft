import { activity } from 'weft';

import type { ShipmentInput, ShipmentResult } from '../model';

export const shipOrder = activity({
  name: 'orderProcessingShipOrder',
  idempotent: true,
  timeout: '20s',
  retry: {
    backoffMultiplier: 2,
    initialBackoff: '500ms',
    maxAttempts: 3,
    maxBackoff: '10s',
  },
  execute: async (input: ShipmentInput): Promise<ShipmentResult> => {
    return {
      carrier: 'GroundShip',
      orderId: input.orderId,
      trackingNumber: `trk_${input.orderId}_${input.reservationIds.length}`,
    };
  },
});
