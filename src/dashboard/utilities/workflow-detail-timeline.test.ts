import { describe, expect, it } from 'bun:test';

import type { WorkflowState, WorkflowTimelineEntry } from '../api-client.ts';
import {
  clearWorkflowTimelineInspectionState,
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
  it('clears the inspection state to empty defaults', () => {
    expect(clearWorkflowTimelineInspectionState()).toEqual({
      selectedStep: null,
      diffFromStep: '',
      diffToStep: '',
      diffRows: [],
      diffLoading: false,
      diffError: null,
    });
  });

  it('clears the inspection state when the timeline is empty', () => {
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

    expect(synchronizeWorkflowTimelineInspectionState([], current)).toEqual(
      clearWorkflowTimelineInspectionState(),
    );
  });

  it('preserves valid selected and diff steps when the refreshed timeline still contains them', () => {
    const current: WorkflowTimelineInspectionState = {
      selectedStep: 2,
      diffFromStep: '2',
      diffToStep: '3',
      diffRows: [],
      diffLoading: false,
      diffError: null,
    };

    expect(synchronizeWorkflowTimelineInspectionState(makeTimeline([1, 2, 3]), current)).toEqual(
      current,
    );
  });

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

  it('returns a workflow-failed result when the workflow request fails', async () => {
    const result = await loadTerminalWorkflowDetailRefresh({
      loadWorkflow: async () => {
        throw new Error('workflow unavailable');
      },
      loadTimeline: async () => makeTimeline([1, 2]),
    });

    expect(result).toEqual({
      status: 'workflow-failed',
      error: expect.any(Error),
      message: 'workflow unavailable',
    });
  });
});
