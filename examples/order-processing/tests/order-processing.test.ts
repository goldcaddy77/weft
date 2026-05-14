import { describe, expect, it } from 'bun:test';
import { TestEngine } from 'weft/testing';

import { createOrderProcessingEngine, orderProcessingSchedule } from '../src/registry';
import {
  addItemUpdate,
  cancelOrderSignal,
  orderStatusQuery,
} from '../src/messages';
import {
  highValueOrderInput,
  staleOrderSweepInput,
  standardOrderInput,
} from '../src/sample-data';
import type { AddItemInput } from '../src/model';

describe('order-processing reference example', () => {
  it('runs the happy path across activities, updates, queries, review, child workflow, and search attributes', async () => {
    await using engine = createOrderProcessingEngine(new TestEngine());

    const handle = await engine.start('orderProcessingOrder', highValueOrderInput, {
      id: highValueOrderInput.orderId,
      searchAttributes: {
        customerId: highValueOrderInput.customerId,
        orderStatus: 'received',
        totalAmount: highValueOrderInput.totalAmount,
      },
    });

    const giftWrapItem: AddItemInput = {
      sku: 'gift-wrap',
      quantity: 1,
      warehouseId: 'denver',
      unitPrice: 5,
    };
    const updateResult = await handle.update(addItemUpdate, giftWrapItem);
    expect(updateResult).toEqual({
      accepted: true,
      itemCount: highValueOrderInput.items.length + 1,
      totalAmount: highValueOrderInput.totalAmount + 5,
    });

    await expect(handle.query(orderStatusQuery)).resolves.toEqual({
      itemCount: highValueOrderInput.items.length + 1,
      orderId: highValueOrderInput.orderId,
      status: 'awaiting-review',
      totalAmount: highValueOrderInput.totalAmount + 5,
    });

    const pendingReviews = await engine.listReviews({ workflowId: highValueOrderInput.orderId });
    expect(pendingReviews).toHaveLength(1);
    expect(pendingReviews[0]).toMatchObject({
      reviewType: 'high-value-order',
      status: 'pending',
    });
    const awaitingReviewOrders = await engine.list({
      attributes: [{ key: 'orderStatus', value: 'awaiting-review' }],
    });
    expect(awaitingReviewOrders.items.map((workflow) => workflow.id)).toContain(
      highValueOrderInput.orderId,
    );

    await engine.submitReview(pendingReviews[0]!.reviewId, {
      decision: 'approved',
      reviewer: 'operations@example.com',
    });
    await expect(handle.result()).resolves.toMatchObject({
      orderId: highValueOrderInput.orderId,
      status: 'shipped',
      trackingNumber: expect.stringContaining('trk_'),
    });

    const allWorkflows = await engine.list();
    expect(allWorkflows.items.map((workflow) => workflow.id)).toContain(highValueOrderInput.orderId);
    expect(allWorkflows.items).toContainEqual(
      expect.objectContaining({
        status: 'completed',
        type: 'orderProcessingShipment',
      }),
    );
  });

  it('compensates inventory and payment when cancellation arrives before shipment', async () => {
    await using engine = createOrderProcessingEngine(new TestEngine());

    const handle = await engine.start('orderProcessingOrder', standardOrderInput, {
      id: standardOrderInput.orderId,
    });

    await handle.signal(cancelOrderSignal, { reason: 'customer-requested' });

    await expect(handle.result()).resolves.toMatchObject({
      orderId: standardOrderInput.orderId,
      refundId: expect.stringContaining('refund_'),
      releasedReservationIds: expect.arrayContaining([expect.stringContaining('res_')]),
      status: 'cancelled',
    });
  });

  it('uses the scheduled sweep workflow to cancel stale running orders', async () => {
    await using engine = createOrderProcessingEngine(new TestEngine());

    const handle = await engine.start('orderProcessingOrder', {
      ...standardOrderInput,
      orderId: 'order_stale',
    });

    const scheduleHandle = await engine.schedule(orderProcessingSchedule);
    await expect(engine.getSchedule(scheduleHandle.id)).resolves.toMatchObject({
      id: scheduleHandle.id,
      status: 'active',
      workflowType: 'orderProcessingSweepStaleOrders',
    });
    await expect(engine.listSchedules({ workflowType: 'orderProcessingSweepStaleOrders' })).resolves
      .toMatchObject({
        items: [expect.objectContaining({ id: scheduleHandle.id })],
      });

    const scheduleDescription = await scheduleHandle.describe();
    expect(scheduleDescription.nextFireAt).toBeNumber();
    await engine.advanceTime(scheduleDescription.nextFireAt! - engine.now);
    const workflows = await engine.list();
    const sweepWorkflow = workflows.items.find(
      (workflow) => workflow.type === 'orderProcessingSweepStaleOrders',
    );
    expect(sweepWorkflow).toMatchObject({
      status: 'completed',
      type: 'orderProcessingSweepStaleOrders',
    });

    const sweepResult = await engine.getHandle(sweepWorkflow!.id).result();
    expect(sweepResult).toEqual({
      cancelledOrderIds: ['order_stale'],
      scannedOrderCount: 1,
    });
    await handle.signal(cancelOrderSignal, { reason: 'stale-order-sweep' });

    await expect(handle.result()).resolves.toMatchObject({
      orderId: 'order_stale',
      status: 'cancelled',
    });
  });
});
