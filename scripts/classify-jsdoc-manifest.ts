/**
 * Helper that applies classification rules to unclassified entries in
 * reference/jsdoc-manifest.json. Reviewable by reading the resulting diff (the
 * prose-only and not-public lists are what matter).
 *
 * Rules:
 *   - publicFaces.length === 0  -> not-public (auto)
 *   - sourceName matches the prose-only pattern below -> prose-only
 *   - everything else           -> example-required
 *
 * The committed manifest intentionally persists only structural fields plus
 * classification. Transient planning fields such as batch/currentState are
 * re-derived by verification scripts and are not written here.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MANIFEST_PATH = resolve(import.meta.dir, '../reference/jsdoc-manifest.json');

type SymbolKind = 'value' | 'type' | 'namespace';
type Classification = 'unclassified' | 'example-required' | 'prose-only' | 'not-public';

type ManifestEntry = {
  sourceFile: string;
  sourceName: string;
  kind: SymbolKind;
  subKind: string;
  publicFaces: { importPath: string; exportName: string; kind: SymbolKind }[];
  classification: Classification;
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

function classify(entry: ManifestEntry): { classification: Classification } {
  if (entry.publicFaces.length === 0) {
    return { classification: 'not-public' };
  }
  // Type-shape returned/read-only structures: prose-only.
  if (entry.kind === 'type' && PROSE_ONLY_NAME_PATTERN.test(entry.sourceName)) {
    return { classification: 'prose-only' };
  }
  return { classification: 'example-required' };
}

function main(): void {
  const args = process.argv.slice(2);
  const reset = args.includes('--reset');
  const manifest: Manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  let proseOnlyCount = 0;
  let notPublicCount = 0;
  let exampleRequiredCount = 0;
  let preserved = 0;

  for (const entry of manifest.entries) {
    // Preserve existing manual classifications by default. The classifier's
    // automated rules cannot encode every domain decision (e.g. "this type
    // looks like a returned shape but users actually construct it"), so any
    // entry whose `classification` is already set to a final value should
    // not be re-classified on subsequent runs. Pass --reset to override.
    const isAlreadyClassified =
      !reset && entry.classification !== 'unclassified' && entry.classification != null;
    const preservedClassificationStillValid =
      entry.classification !== 'not-public' || entry.publicFaces.length === 0;
    if (!isAlreadyClassified || !preservedClassificationStillValid) {
      const { classification } = classify(entry);
      entry.classification = classification;
    } else {
      preserved++;
    }
    if (entry.classification === 'prose-only') proseOnlyCount++;
    else if (entry.classification === 'not-public') notPublicCount++;
    else exampleRequiredCount++;
  }

  // Strip transient fields before persisting — same pick-list as
  // build-jsdoc-manifest.ts. `batch`, `classificationRationale`, and
  // `currentState` are regenerated on every classify/build run and would
  // only add noise to the diff. `classification` is the only semantic
  // field this script writes that needs to survive.
  const persistedEntries = manifest.entries.map((entry) => ({
    sourceFile: entry.sourceFile,
    sourceName: entry.sourceName,
    kind: entry.kind,
    subKind: entry.subKind,
    publicFaces: entry.publicFaces,
    classification: entry.classification,
  }));
  const persistedManifest = {
    publicEntryPoints: manifest.publicEntryPoints,
    entries: persistedEntries,
  };
  writeFileSync(MANIFEST_PATH, JSON.stringify(persistedManifest, null, 2) + '\n', 'utf8');

  console.log(
    `Classified ${manifest.entries.length} entries (${preserved} preserved from prior run):`,
  );
  console.log(`  example-required: ${exampleRequiredCount}`);
  console.log(`  prose-only:       ${proseOnlyCount}`);
  console.log(`  not-public:       ${notPublicCount}`);
}

main();
