/**
 * `weft visibility backfill|verify|drop` — the operator surface for the
 * workflow visibility index that `engine.list()` and `engine.aggregate()`
 * consult.
 *
 * `WorkflowListScanCapExceededError` tells operators to "run the
 * visibility-index backfill". This command is that backfill, and unlike the
 * repository-local script it ships with the package and opens any storage
 * backend the CLI supports rather than a Bun SQLite file specifically.
 *
 * @module cli/visibility
 */

import type { Storage } from '../storage/interface.ts';
import type { CommandOutput, PersistentStorageBackend } from './types.ts';

/** The three things an operator can do to the visibility index. */
export type VisibilityAction = 'backfill' | 'verify' | 'drop';

/** Parsed `weft visibility` invocation. */
export type VisibilityCommandOptions = {
  action: VisibilityAction;
  database: string;
  storage: PersistentStorageBackend;
  batchSize: number;
  deep: boolean;
  json: boolean;
  verbose: boolean;
};

/**
 * Exit code meaning "the index is not current". Both a conflicted backfill
 * and an incomplete verify report it, because the operator action is the
 * same in each case: keep writers paused and run the backfill again.
 */
export const VISIBILITY_NOT_CURRENT_EXIT_CODE = 3;

/** Exit code meaning the backend cannot support a race-safe backfill. */
export const VISIBILITY_UNSUPPORTED_BACKEND_EXIT_CODE = 2;

const UNSUPPORTED_BACKEND_GUIDANCE = [
  'Backfill cannot run while the engine is processing writes — a racing',
  'runtime update could leave a workflow un-indexed below the cursor.',
  'Stop the engine, re-run the backfill, then restart.',
].join('\n');

function isMissingConditionalBatchError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Storage backend does not expose');
}

type VisibilityRunContext = {
  readonly options: VisibilityCommandOptions;
  readonly storage: Storage;
  readonly logLines: string[];
  readonly logger: (message: string) => void;
};

/** Run one `weft visibility` action and render its report. */
export async function executeVisibility(
  options: VisibilityCommandOptions,
): Promise<CommandOutput> {
  const { createStorage } = await import('./storage-factory.ts');
  const storage = await createStorage(options.storage, options.database);
  const logLines: string[] = [];
  const context: VisibilityRunContext = {
    options,
    storage,
    logLines,
    logger: (message: string): void => {
      if (options.verbose) logLines.push(message);
    },
  };

  try {
    if (options.action === 'drop') return await runDrop(context);
    if (options.action === 'verify') return await runVerify(context);
    return await runBackfill(context);
  } finally {
    await disposeStorage(storage);
  }
}

async function runDrop(context: VisibilityRunContext): Promise<CommandOutput> {
  const { runWorkflowVisibilityDrop } = await import(
    '../core/engine/workflow-visibility-backfill.ts'
  );
  const report = await runWorkflowVisibilityDrop(context.storage, { logger: context.logger });
  return renderOutput(context, report, [
    `Dropped the workflow visibility index (${report.rowsDeleted} rows). Listings are back on the full-scan path.`,
  ]);
}

async function runVerify(context: VisibilityRunContext): Promise<CommandOutput> {
  const { verifyWorkflowVisibilityIndex } = await import(
    '../core/engine/workflow-visibility-backfill.ts'
  );
  const report = await verifyWorkflowVisibilityIndex(context.storage, {
    deep: context.options.deep,
    logger: context.logger,
  });

  const summary = [
    `Scanned ${report.scanned} workflows; ${report.covered} covered, ${report.scanned - report.covered} with gaps.`,
    `Watermark: ${report.watermark}.`,
    ...verifyVerdict(report.watermarkOverstated, report.complete, report.watermark === 'current'),
    ...report.gaps.map((gap) => `  gap: ${gap.workflowId} (${gap.reason})`),
  ];

  const isCurrent = report.complete && report.watermark === 'current';
  return renderOutput(context, report, summary, isCurrent ? 0 : VISIBILITY_NOT_CURRENT_EXIT_CODE);
}

function verifyVerdict(
  overstated: boolean,
  complete: boolean,
  watermarkCurrent: boolean,
): string[] {
  if (overstated) {
    return [
      'DANGER: the watermark claims the index is current but coverage is incomplete.',
      'Filtered listings are omitting workflows rather than falling back to a scan.',
      'Pause writers, run `weft visibility drop`, then `weft visibility backfill`.',
    ];
  }
  if (!complete) return ['Index is incomplete. Run `weft visibility backfill`.'];
  if (!watermarkCurrent) {
    return [
      'Coverage is complete but the watermark is stale, so listings still full-scan.',
      'Run `weft visibility backfill` to advance it.',
    ];
  }
  return ['Index is current and complete.'];
}

async function runBackfill(context: VisibilityRunContext): Promise<CommandOutput> {
  const { runWorkflowVisibilityBackfill } = await import(
    '../core/engine/workflow-visibility-backfill.ts'
  );

  try {
    const report = await runWorkflowVisibilityBackfill(context.storage, {
      checkpointEvery: context.options.batchSize,
      logger: context.logger,
    });
    if (report.watermarkWritten) {
      return renderOutput(context, report, [
        `Backfill complete. Processed ${report.processed} workflows. Watermark advanced.`,
      ]);
    }
    return renderOutput(
      context,
      report,
      [
        `Backfill processed ${report.processed} workflows but skipped ${report.conflicts} racing and ${report.oversized} oversized. Watermark left stale; re-run to converge.`,
      ],
      VISIBILITY_NOT_CURRENT_EXIT_CODE,
    );
  } catch (error) {
    if (!isMissingConditionalBatchError(error)) throw error;
    return {
      stdout: '',
      stderr: `${(error as Error).message}\n${UNSUPPORTED_BACKEND_GUIDANCE}`,
      exitCode: VISIBILITY_UNSUPPORTED_BACKEND_EXIT_CODE,
    };
  }
}

async function disposeStorage(storage: Storage): Promise<void> {
  if (Symbol.asyncDispose in storage) {
    await (storage as AsyncDisposable)[Symbol.asyncDispose]();
    return;
  }
  if (Symbol.dispose in storage) (storage as Disposable)[Symbol.dispose]();
}

function renderOutput(
  context: VisibilityRunContext,
  report: unknown,
  summary: readonly string[],
  exitCode = 0,
): CommandOutput {
  if (context.options.json) {
    return {
      stdout: JSON.stringify({ action: context.options.action, report }, null, 2),
      exitCode,
    };
  }
  return { stdout: [...context.logLines, ...summary].join('\n'), exitCode };
}
