import { describe, expect, it } from 'bun:test';

import type { WorkflowReplay } from '../../core/types.ts';
import {
  buildWorkflowTimelineDiff,
  formatTimelineDiffValue,
  WorkflowTimelineRequestGuard,
  type WorkflowTimelineDiffRow,
} from './workflow-execution-timeline';

function makeReplay(
  step: number,
  locals: Record<string, unknown>,
  searchAttributes: Record<string, string | number | boolean | Date | string[]>,
): WorkflowReplay {
  return {
    checkpoint: {
      step,
      locals,
      searchAttributes,
      version: '1.0.0',
      createdAt: step * 1_000,
    },
    accumulatedResults: [],
    events: [],
  };
}

describe('workflow execution timeline helpers', () => {
  it('reports new locals, changed search attributes, budget delta, and conversation growth', () => {
    const before = makeReplay(
      1,
      {
        cart: { items: ['book'] },
        messages: [{ role: 'user', content: 'approve order' }],
      },
      {
        status: 'pending',
        'weft:tokenCost': 0.12,
      },
    );
    const after = makeReplay(
      2,
      {
        cart: { items: ['book'], total: 42 },
        messages: [
          { role: 'user', content: 'approve order' },
          { role: 'assistant', content: 'approved' },
        ],
        plan: 'ship',
      },
      {
        status: 'approved',
        'weft:tokenCost': 0.28,
      },
    );

    const rows = buildWorkflowTimelineDiff(before, after);

    expect(rows).toContainEqual(
      expect.objectContaining({
        section: 'locals',
        label: 'locals.plan',
        change: 'added',
        after: 'ship',
      }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        section: 'searchAttributes',
        label: 'searchAttributes.status',
        change: 'changed',
        before: 'pending',
        after: 'approved',
      }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        section: 'budget',
        label: 'budget.weft:tokenCost',
        change: 'delta',
        before: 0.12,
        after: 0.28,
      }),
    );
    expect(rows.filter((row) => row.label.includes('weft:tokenCost'))).toEqual([
      expect.objectContaining({
        section: 'budget',
        label: 'budget.weft:tokenCost',
      }),
    ]);
    expect(rows).toContainEqual(
      expect.objectContaining({
        section: 'conversation',
        label: 'conversation.messages',
        change: 'delta',
        before: 1,
        after: 2,
      }),
    );
  });

  it('formats primitive, object, and missing diff values for compact tables', () => {
    expect(formatTimelineDiffValue(undefined)).toBe('-');
    expect(formatTimelineDiffValue('approved')).toBe('approved');
    expect(formatTimelineDiffValue(42)).toBe('42');
    expect(formatTimelineDiffValue({ total: 42 })).toBe('{"total":42}');
    expect(formatTimelineDiffValue(Symbol('phase'))).toBe('Symbol(phase)');
    expect(formatTimelineDiffValue(() => 'ignored')).toBe('[function]');
  });

  it('ignores stale replay responses when rapid step selections resolve out of order', async () => {
    const requestGuard = new WorkflowTimelineRequestGuard();
    let selectedStep = 0;
    const selectedReplay: { value: WorkflowReplay | null } = { value: null };

    async function loadReplay(step: number, replayPromise: Promise<WorkflowReplay>): Promise<void> {
      const requestToken = requestGuard.createRequestToken();
      selectedStep = step;
      const replay = await replayPromise;
      if (!requestGuard.isCurrentRequest(requestToken)) return;
      selectedReplay.value = replay;
    }

    let resolveFirstReplay: (replay: WorkflowReplay) => void = () => {};
    let resolveSecondReplay: (replay: WorkflowReplay) => void = () => {};
    const firstReplayPromise = new Promise<WorkflowReplay>((resolve) => {
      resolveFirstReplay = resolve;
    });
    const secondReplayPromise = new Promise<WorkflowReplay>((resolve) => {
      resolveSecondReplay = resolve;
    });
    const firstReplay = makeReplay(1, { selected: 'first' }, {});
    const secondReplay = makeReplay(2, { selected: 'second' }, {});

    const firstLoad = loadReplay(1, firstReplayPromise);
    const secondLoad = loadReplay(2, secondReplayPromise);

    resolveSecondReplay(secondReplay);
    await secondLoad;
    resolveFirstReplay(firstReplay);
    await firstLoad;

    expect(selectedStep).toBe(2);
    expect(selectedReplay.value).toBe(secondReplay);
  });

  it('ignores stale diff errors after the selected comparison steps change', async () => {
    const requestGuard = new WorkflowTimelineRequestGuard();
    let fromStep = '1';
    let toStep = '2';
    let diffError: string | null = null;
    let diffRows: WorkflowTimelineDiffRow[] = [
      {
        section: 'locals',
        label: 'locals.plan',
        change: 'added',
        before: undefined,
        after: 'ship',
      },
    ];

    async function compareDiff(diffPromise: Promise<WorkflowTimelineDiffRow[]>): Promise<void> {
      const requestToken = requestGuard.createRequestToken();
      const requestedFromStep = fromStep;
      const requestedToStep = toStep;

      try {
        diffRows = await diffPromise;
      } catch (error) {
        if (
          !requestGuard.isCurrentRequest(requestToken) ||
          requestedFromStep !== fromStep ||
          requestedToStep !== toStep
        ) {
          return;
        }

        diffRows = [];
        diffError = error instanceof Error ? error.message : String(error);
      }
    }

    let rejectDiff: (error: Error) => void = () => {};
    const diffPromise = new Promise<WorkflowTimelineDiffRow[]>((_resolve, reject) => {
      rejectDiff = reject;
    });
    const compare = compareDiff(diffPromise);

    fromStep = '2';
    toStep = '3';
    rejectDiff(new Error('stale diff failure'));
    await compare;

    expect(diffError).toBeNull();
    expect(diffRows).toEqual([
      {
        section: 'locals',
        label: 'locals.plan',
        change: 'added',
        before: undefined,
        after: 'ship',
      },
    ]);
  });
});
