/**
 * One-shot helper that applies classification + batching rules to every entry
 * in reference/jsdoc-manifest.json. Reviewable by reading the resulting diff
 * (the prose-only and not-public lists are what matter).
 *
 * Rules:
 *   - publicFaces.length === 0  -> not-public (auto)
 *   - sourceName matches the prose-only pattern below -> prose-only
 *   - everything else           -> example-required
 *
 * Batching:
 *   - currentState === 'has-example'  -> batch: null (exemplars, untouched)
 *   - currentState === 'prose-only'   -> Phase A batch (augmentation)
 *   - currentState === 'no-jsdoc'     -> Phase B batch (authorship)
 *
 * Within a phase, batch is determined by sourceFile prefix:
 *   - src/core, src/runtime    -> A1-core | B1-core
 *   - src/storage, src/server, src/worker, src/workers, src/observability,
 *     src/client, src/diagnostics, src/alerting, src/testing -> A2-infra | B2-infra
 *   - src/ai                   -> A3-ai | B3-ai
 *
 * not-public entries get batch: null.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MANIFEST_PATH = resolve(import.meta.dir, '../reference/jsdoc-manifest.json');

type SymbolKind = 'value' | 'type' | 'namespace';
type CurrentState = 'no-jsdoc' | 'prose-only' | 'has-example';
type Classification = 'unclassified' | 'example-required' | 'prose-only' | 'not-public';

type ManifestEntry = {
  sourceFile: string;
  sourceName: string;
  kind: SymbolKind;
  subKind: string;
  publicFaces: { importPath: string; exportName: string; kind: SymbolKind }[];
  classification: Classification;
  currentState: CurrentState;
  classificationRationale: string | null;
  batch: string | null;
};

type Manifest = {
  publicEntryPoints: Record<string, string>;
  entries: ManifestEntry[];
};

// ---------------------------------------------------------------------------
// Classification heuristic for type-shape entries that are "returned but not
// constructed" by users — examples for these would be misleading because the
// engine produces them, the user reads them.
//
// Match by name suffix/pattern. False positives (ResolvedFoo etc.) get hand-
// corrected after review.
// ---------------------------------------------------------------------------

const PROSE_ONLY_NAME_PATTERN =
  /^(ActivityCompletedInterception|ActivityFailedInterception|AlertAction|AlertState|AnnotateResult|AssistantMessage|BatchOperation|BudgetState|BulkCancelResult|BulkDeleteResult|BulkOperationError|BulkSignalResult|BulkTagResult|ChatResponse|CheckpointState|CheckpointSummary|ChildWorkflowOptions|ConditionalBatchCondition|ConstraintCheckState|ConstraintViolation|CoordinatedUpdateResult|DatabaseHealth|DiagnosticReport|FieldDiff|ForkLineage|HealthStatus|InvocationResult|JsonValue|LargestCheckpoint|LongestRunningWorkflow|MemoryProfile|MemorySample|MessagePackValue|ModelUsageEntry|NormalizedRetentionPolicy|PaginatedResult|PrometheusExporter|PurgeResult|QueueStatistics|Recommendation|RecommendationSeverity|ReviewDecision|RoutingPolicy|RuntimeKind|ScheduleAccessOptions|ScheduleFilter|ScheduleState|ScheduleStatus|ScheduleSummary|SchedulingPolicy|SerializedBudgetState|ShapeDescriptor|ShapeDiffOptions|StabilityResult|StorageSizeReport|StorageValueParser|StoredStreamChunk|TenantQuotaMetricUsage|TenantQuotaUsage|TenantWorkflowCreationRateUsage|TokenUsage|ToolIdentityResult|TurnCostEntry|UpdateResult|VersionCheckReport|WorkflowEvent|WorkflowReplay|WorkflowSessionState|WorkflowState|WorkflowStatistics|WorkflowStatus|WorkflowStatusCounts|WorkflowSummary|WorkflowTimelineEntry|WorkflowTimelineStatus|WorkflowTypeReport)$/;

function classify(entry: ManifestEntry): {
  classification: Classification;
  rationale: string | null;
} {
  if (entry.publicFaces.length === 0) {
    return {
      classification: 'not-public',
      rationale: 'exported from a source file but not re-exported through any public entry point',
    };
  }
  // Type-shape returned/read-only structures: prose-only.
  if (entry.kind === 'type' && PROSE_ONLY_NAME_PATTERN.test(entry.sourceName)) {
    return {
      classification: 'prose-only',
      rationale: 'returned/read-only shape — users observe rather than construct it',
    };
  }
  return { classification: 'example-required', rationale: null };
}

function batchFor(entry: ManifestEntry, classification: Classification): string | null {
  if (classification === 'not-public') return null;
  if (entry.currentState === 'has-example') return null;
  // prose-only entries are satisfied as soon as currentState reaches 'prose-only'
  // — no @example required, so no work to assign.
  if (classification === 'prose-only' && entry.currentState === 'prose-only') return null;
  // example-required + prose-only currentState → Phase A (augmentation).
  // example-required + no-jsdoc currentState   → Phase B (authorship).
  // prose-only + no-jsdoc currentState         → Phase B (authorship — needs prose).
  const phase = entry.currentState === 'prose-only' ? 'A' : 'B';
  const sourceFile = entry.sourceFile;
  let domain: '1-core' | '2-infra' | '3-ai';
  if (sourceFile.startsWith('src/core/') || sourceFile.startsWith('src/runtime/')) {
    domain = '1-core';
  } else if (sourceFile.startsWith('src/ai/')) {
    domain = '3-ai';
  } else {
    domain = '2-infra';
  }
  return `${phase}${domain}`;
}

function main(): void {
  const args = process.argv.slice(2);
  const reset = args.includes('--reset');
  const manifest: Manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  let proseOnlyCount = 0;
  let notPublicCount = 0;
  let exampleRequiredCount = 0;
  let preserved = 0;
  const batchCounts = new Map<string, number>();

  for (const entry of manifest.entries) {
    // Preserve existing manual classifications by default. The classifier's
    // automated rules cannot encode every domain decision (e.g. "this type
    // looks like a returned shape but users actually construct it"), so any
    // entry whose `classification` is already set to a final value should
    // not be re-classified on subsequent runs. Pass --reset to override.
    const isAlreadyClassified =
      !reset && entry.classification !== 'unclassified' && entry.classification != null;
    if (!isAlreadyClassified) {
      const { classification, rationale } = classify(entry);
      entry.classification = classification;
      entry.classificationRationale = rationale;
    } else {
      preserved++;
    }
    entry.batch = batchFor(entry, entry.classification);
    if (entry.classification === 'prose-only') proseOnlyCount++;
    else if (entry.classification === 'not-public') notPublicCount++;
    else exampleRequiredCount++;
    if (entry.batch) batchCounts.set(entry.batch, (batchCounts.get(entry.batch) ?? 0) + 1);
  }

  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log(
    `Classified ${manifest.entries.length} entries (${preserved} preserved from prior run):`,
  );
  console.log(`  example-required: ${exampleRequiredCount}`);
  console.log(`  prose-only:       ${proseOnlyCount}`);
  console.log(`  not-public:       ${notPublicCount}`);
  console.log('Batch distribution:');
  for (const [batch, count] of [...batchCounts.entries()].toSorted(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    console.log(`  ${batch}: ${count}`);
  }
}

main();
