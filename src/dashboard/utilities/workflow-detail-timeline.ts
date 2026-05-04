import type { WorkflowState, WorkflowTimelineEntry } from '../api-client.ts';
import type { WorkflowTimelineDiffRow } from '../fragments/workflow-execution-timeline.ts';

export type WorkflowTimelineInspectionState = {
  selectedStep: number | null;
  diffFromStep: string;
  diffToStep: string;
  diffRows: WorkflowTimelineDiffRow[];
  diffLoading: boolean;
  diffError: string | null;
};

export type SynchronizeWorkflowTimelineInspectionOptions = {
  resetDiff?: boolean;
};

export type TerminalWorkflowDetailRefreshResult =
  | {
      status: 'updated';
      workflow: WorkflowState | null;
      timeline: WorkflowTimelineEntry[] | null;
      timelineError: string | null;
    }
  | {
      status: 'workflow-failed';
      error: unknown;
      message: string;
    };

export function clearWorkflowTimelineInspectionState(): WorkflowTimelineInspectionState {
  return {
    selectedStep: null,
    diffFromStep: '',
    diffToStep: '',
    diffRows: [],
    diffLoading: false,
    diffError: null,
  };
}

// oxlint-disable-next-line complexity -- ID:dashboard-utilities-workflow-detail-timeline-synchronize-workflow-timeline-inspection-state-complexity
export function synchronizeWorkflowTimelineInspectionState(
  timeline: readonly WorkflowTimelineEntry[],
  current: WorkflowTimelineInspectionState,
  options: SynchronizeWorkflowTimelineInspectionOptions = {},
): WorkflowTimelineInspectionState {
  if (timeline.length === 0) {
    return clearWorkflowTimelineInspectionState();
  }

  const availableSteps = new Set(timeline.map((entry) => entry.step));
  const firstStep = timeline[0]?.step ?? null;
  const lastStep = timeline.at(-1)?.step ?? null;
  const selectedStep =
    current.selectedStep !== null && availableSteps.has(current.selectedStep)
      ? current.selectedStep
      : firstStep;

  const shouldResetDiff = options.resetDiff === true;

  return {
    selectedStep,
    diffFromStep: selectTimelineDiffStep({
      currentStep: current.diffFromStep,
      fallbackStep: firstStep,
      availableSteps,
      shouldResetDiff,
    }),
    diffToStep: selectTimelineDiffStep({
      currentStep: current.diffToStep,
      fallbackStep: lastStep,
      availableSteps,
      shouldResetDiff,
    }),
    diffRows: shouldResetDiff ? [] : current.diffRows,
    diffLoading: shouldResetDiff ? false : current.diffLoading,
    diffError: shouldResetDiff ? null : current.diffError,
  };
}

export async function loadTerminalWorkflowDetailRefresh({
  loadWorkflow,
  loadTimeline,
}: {
  loadWorkflow: () => Promise<WorkflowState | null>;
  loadTimeline: () => Promise<WorkflowTimelineEntry[]>;
}): Promise<TerminalWorkflowDetailRefreshResult> {
  let workflow: WorkflowState | null;

  try {
    workflow = await loadWorkflow();
  } catch (error) {
    return {
      status: 'workflow-failed',
      error,
      message: formatWorkflowTimelineError(error),
    };
  }

  try {
    return {
      status: 'updated',
      workflow,
      timeline: await loadTimeline(),
      timelineError: null,
    };
  } catch (error) {
    return {
      status: 'updated',
      workflow,
      timeline: null,
      timelineError: formatWorkflowTimelineError(error),
    };
  }
}

function selectTimelineDiffStep({
  currentStep,
  fallbackStep,
  availableSteps,
  shouldResetDiff,
}: {
  currentStep: string;
  fallbackStep: number | null;
  availableSteps: ReadonlySet<number>;
  shouldResetDiff: boolean;
}): string {
  if (!shouldResetDiff && currentStep !== '' && availableSteps.has(Number(currentStep))) {
    return currentStep;
  }

  return fallbackStep === null ? '' : String(fallbackStep);
}

function formatWorkflowTimelineError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
