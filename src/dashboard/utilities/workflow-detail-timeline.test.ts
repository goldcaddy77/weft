import { describe, expect, it } from 'bun:test';

import type { WorkflowState, WorkflowTimelineEntry } from '../api-client.ts';
import {
  loadTerminalWorkflowDetailRefresh,
  synchronizeWorkflowTimelineInspectionState,
  type WorkflowTimelineInspectionState,
} from './workflow-detail-timeline.ts';

function makeTimeline(steps: number[]): WorkflowTimelineEntry[] {
  return steps.map((step) => ({
    step,
    operationType: 'activity',
    operationLabel: `step-${step}`,
    inputSummary: '{}',
    outputSummary: '{}',
    duration: step,
    timestamp: step * 1_000,
    status: 'completed',
  }));
}

function makeWorkflow(status: WorkflowState['status']): WorkflowState {
  return {
    id: 'workflow-a',
    type: 'test-workflow',
    status,
    input: {},
    version: '1.0.0',
    createdAt: 1_000,
    updatedAt: 2_000,
  };
}

describe('workflow detail timeline utilities', () => {
  it('resets stale diff rows, loading, and errors when a new workflow timeline is loaded', () => {
    const current: WorkflowTimelineInspectionState = {
      selectedStep: 2,
      diffFromStep: '1',
      diffToStep: '2',
      diffRows: [
        {
          section: 'locals',
          label: 'locals.previousWorkflow',
          change: 'added',
          before: undefined,
          after: true,
        },
      ],
      diffLoading: true,
      diffError: 'previous workflow diff failed',
    };

    const nextState = synchronizeWorkflowTimelineInspectionState(makeTimeline([1, 2]), current, {
      resetDiff: true,
    });

    expect(nextState).toEqual({
      selectedStep: 2,
      diffFromStep: '1',
      diffToStep: '2',
      diffRows: [],
      diffLoading: false,
      diffError: null,
    });
  });

  it('keeps workflow terminal refresh usable when the timeline request fails', async () => {
    const terminalWorkflow = makeWorkflow('completed');

    const result = await loadTerminalWorkflowDetailRefresh({
      loadWorkflow: async () => terminalWorkflow,
      loadTimeline: async () => {
        throw new Error('timeline unavailable');
      },
    });

    expect(result).toEqual({
      status: 'updated',
      workflow: terminalWorkflow,
      timeline: null,
      timelineError: 'timeline unavailable',
    });
  });
});
