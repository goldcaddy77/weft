import type {
  TaskDiagnosticsResponse,
  WorkflowState,
  WorkflowTimelineEntry,
} from '../api-client.ts';
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

export type WorkflowTaskDiagnosticEvidence = {
  operationId: string;
  activityName: string;
  queueEvidence: string;
  workerEvidence: string;
  retryEvidence: string;
  heartbeatEvidence: string;
  evidence: string[];
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

export function synchronizeWorkflowTimelineInspectionState(
  timeline: readonly WorkflowTimelineEntry[],
  current: WorkflowTimelineInspectionState,
  options: SynchronizeWorkflowTimelineInspectionOptions = {},
): WorkflowTimelineInspectionState {
  if (timeline.length === 0) {
    return clearWorkflowTimelineInspectionState();
  }

  const timelineSteps = getTimelineStepSelection(timeline);
  const shouldResetDiff = options.resetDiff === true;

  return {
    selectedStep: selectTimelineStep(current.selectedStep, timelineSteps),
    diffFromStep: selectTimelineDiffStep({
      currentStep: current.diffFromStep,
      fallbackStep: timelineSteps.firstStep,
      availableSteps: timelineSteps.availableSteps,
      shouldResetDiff,
    }),
    diffToStep: selectTimelineDiffStep({
      currentStep: current.diffToStep,
      fallbackStep: timelineSteps.lastStep,
      availableSteps: timelineSteps.availableSteps,
      shouldResetDiff,
    }),
    ...selectTimelineDiffRequestState(current, shouldResetDiff),
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

export function buildWorkflowTaskDiagnosticEvidence(
  workflowId: string,
  diagnostics: TaskDiagnosticsResponse,
): WorkflowTaskDiagnosticEvidence[] {
  return diagnostics.items.flatMap((item) => {
    if (item.workflowId !== workflowId || item.operationId === undefined) return [];
    return [
      {
        operationId: item.operationId,
        activityName: item.activityName ?? item.operationId,
        queueEvidence: item.queue ?? 'unknown queue',
        workerEvidence: item.workerId ?? 'no worker assigned',
        retryEvidence: formatRetryEvidence(item.retryCount, item.requeueCount),
        heartbeatEvidence:
          item.heartbeatAgeMs === undefined
            ? 'no heartbeat evidence'
            : `${formatDiagnosticDuration(item.heartbeatAgeMs)} since last heartbeat`,
        evidence: [...item.evidence],
      },
    ];
  });
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

function getTimelineStepSelection(timeline: readonly WorkflowTimelineEntry[]): {
  availableSteps: ReadonlySet<number>;
  firstStep: number | null;
  lastStep: number | null;
} {
  return {
    availableSteps: new Set(timeline.map((entry) => entry.step)),
    firstStep: timeline[0]?.step ?? null,
    lastStep: timeline.at(-1)?.step ?? null,
  };
}

function selectTimelineStep(
  currentStep: number | null,
  timelineSteps: ReturnType<typeof getTimelineStepSelection>,
): number | null {
  return currentStep !== null && timelineSteps.availableSteps.has(currentStep)
    ? currentStep
    : timelineSteps.firstStep;
}

function selectTimelineDiffRequestState(
  current: WorkflowTimelineInspectionState,
  shouldResetDiff: boolean,
): Pick<WorkflowTimelineInspectionState, 'diffRows' | 'diffLoading' | 'diffError'> {
  return shouldResetDiff
    ? { diffRows: [], diffLoading: false, diffError: null }
    : {
        diffRows: current.diffRows,
        diffLoading: current.diffLoading,
        diffError: current.diffError,
      };
}

function formatWorkflowTimelineError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatRetryEvidence(retryCount: number, requeueCount: number): string {
  return `${retryCount} ${retryCount === 1 ? 'retry' : 'retries'}, ${requeueCount} ${
    requeueCount === 1 ? 'requeue' : 'requeues'
  }`;
}

function formatDiagnosticDuration(milliseconds: number): string {
  if (milliseconds >= 1_000 && milliseconds % 1_000 === 0) {
    return `${milliseconds / 1_000}s`;
  }
  return `${milliseconds}ms`;
}
