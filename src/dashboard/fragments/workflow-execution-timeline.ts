import type { WorkflowReplay } from '../../core/types.ts';

export type WorkflowTimelineDiffSection = 'locals' | 'searchAttributes' | 'budget' | 'conversation';

export type WorkflowTimelineDiffChange = 'added' | 'removed' | 'changed' | 'delta';

export type WorkflowTimelineDiffRow = {
  section: WorkflowTimelineDiffSection;
  label: string;
  change: WorkflowTimelineDiffChange;
  before: unknown;
  after: unknown;
};

export class WorkflowTimelineRequestGuard {
  #currentRequestToken = 0;

  createRequestToken(): number {
    this.#currentRequestToken += 1;
    return this.#currentRequestToken;
  }

  isCurrentRequest(requestToken: number): boolean {
    return requestToken === this.#currentRequestToken;
  }
}

type DiffCandidate =
  | { readonly missing: true }
  | { readonly missing: false; readonly value: unknown };
type DiffTraversal =
  | {
      readonly kind: 'array';
      readonly before: readonly unknown[];
      readonly after: readonly unknown[];
    }
  | {
      readonly kind: 'record';
      readonly before: Record<string, unknown>;
      readonly after: Record<string, unknown>;
    };

const missingValue: DiffCandidate = { missing: true };
const dedicatedBudgetSearchAttributeKey = 'weft:tokenCost';

function presentValue(value: unknown): DiffCandidate {
  return { missing: false, value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isConversationMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value['role'] === 'string' &&
    (typeof value['content'] === 'string' || 'toolCalls' in value || 'toolResults' in value)
  );
}

function collectMessageArrayLengths(value: unknown, lengths: number[]): void {
  if (Array.isArray(value)) {
    if (value.every(isConversationMessage)) {
      lengths.push(value.length);
      return;
    }

    for (const item of value) {
      collectMessageArrayLengths(item, lengths);
    }
    return;
  }

  if (isRecord(value)) {
    for (const child of Object.values(value)) {
      collectMessageArrayLengths(child, lengths);
    }
  }
}

function getLargestConversationMessageCount(value: unknown): number {
  const lengths: number[] = [];
  collectMessageArrayLengths(value, lengths);
  return lengths.length === 0 ? 0 : Math.max(...lengths);
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function getGenericSearchAttributes(
  searchAttributes: WorkflowReplay['checkpoint']['searchAttributes'],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(searchAttributes).filter(([key]) => key !== dedicatedBudgetSearchAttributeKey),
  );
}

function addLeafDiff(
  section: WorkflowTimelineDiffSection,
  label: string,
  beforeValue: DiffCandidate,
  afterValue: DiffCandidate,
  rows: WorkflowTimelineDiffRow[],
): void {
  if (beforeValue.missing) {
    rows.push({
      section,
      label,
      change: 'added',
      before: undefined,
      after: afterValue.missing ? undefined : afterValue.value,
    });
    return;
  }

  if (afterValue.missing) {
    rows.push({ section, label, change: 'removed', before: beforeValue.value, after: undefined });
    return;
  }

  rows.push({
    section,
    label,
    change: 'changed',
    before: beforeValue.value,
    after: afterValue.value,
  });
}

function hasSamePresentValue(beforeValue: DiffCandidate, afterValue: DiffCandidate): boolean {
  return (
    !beforeValue.missing && !afterValue.missing && Object.is(beforeValue.value, afterValue.value)
  );
}

function getDiffTraversal(
  beforeValue: DiffCandidate,
  afterValue: DiffCandidate,
): DiffTraversal | null {
  if (beforeValue.missing || afterValue.missing) return null;

  if (Array.isArray(beforeValue.value) && Array.isArray(afterValue.value)) {
    return { kind: 'array', before: beforeValue.value, after: afterValue.value };
  }

  if (isPlainObjectRecord(beforeValue.value) && isPlainObjectRecord(afterValue.value)) {
    return { kind: 'record', before: beforeValue.value, after: afterValue.value };
  }

  return null;
}

function collectArrayValueDiffs(
  section: WorkflowTimelineDiffSection,
  label: string,
  beforeArray: readonly unknown[],
  afterArray: readonly unknown[],
  rows: WorkflowTimelineDiffRow[],
): void {
  const length = Math.max(beforeArray.length, afterArray.length);
  for (let index = 0; index < length; index++) {
    collectValueDiffs(
      section,
      `${label}[${index}]`,
      index in beforeArray ? presentValue(beforeArray[index]) : missingValue,
      index in afterArray ? presentValue(afterArray[index]) : missingValue,
      rows,
    );
  }
}

function collectRecordValueDiffs(
  section: WorkflowTimelineDiffSection,
  label: string,
  beforeRecord: Record<string, unknown>,
  afterRecord: Record<string, unknown>,
  rows: WorkflowTimelineDiffRow[],
): void {
  const keys = new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)]);
  for (const key of [...keys].toSorted()) {
    collectValueDiffs(
      section,
      `${label}.${key}`,
      Object.hasOwn(beforeRecord, key) ? presentValue(beforeRecord[key]) : missingValue,
      Object.hasOwn(afterRecord, key) ? presentValue(afterRecord[key]) : missingValue,
      rows,
    );
  }
}

function collectNestedValueDiffs(
  section: WorkflowTimelineDiffSection,
  label: string,
  traversal: DiffTraversal,
  rows: WorkflowTimelineDiffRow[],
): void {
  if (traversal.kind === 'array') {
    collectArrayValueDiffs(section, label, traversal.before, traversal.after, rows);
    return;
  }

  collectRecordValueDiffs(section, label, traversal.before, traversal.after, rows);
}

function collectValueDiffs(
  section: WorkflowTimelineDiffSection,
  label: string,
  beforeValue: DiffCandidate,
  afterValue: DiffCandidate,
  rows: WorkflowTimelineDiffRow[],
): void {
  if (hasSamePresentValue(beforeValue, afterValue)) {
    return;
  }

  const traversal = getDiffTraversal(beforeValue, afterValue);

  if (traversal !== null) {
    collectNestedValueDiffs(section, label, traversal, rows);
    return;
  }

  addLeafDiff(section, label, beforeValue, afterValue, rows);
}

function collectBudgetDiff(
  beforeReplay: WorkflowReplay,
  afterReplay: WorkflowReplay,
): WorkflowTimelineDiffRow[] {
  const beforeTokenCost = readNumber(
    beforeReplay.checkpoint.searchAttributes[dedicatedBudgetSearchAttributeKey],
  );
  const afterTokenCost = readNumber(
    afterReplay.checkpoint.searchAttributes[dedicatedBudgetSearchAttributeKey],
  );

  if (beforeTokenCost === null && afterTokenCost === null) {
    return [];
  }

  if (beforeTokenCost === null) {
    return [
      {
        section: 'budget',
        label: 'budget.weft:tokenCost',
        change: 'added',
        before: undefined,
        after: afterTokenCost,
      },
    ];
  }

  if (afterTokenCost === null) {
    return [
      {
        section: 'budget',
        label: 'budget.weft:tokenCost',
        change: 'removed',
        before: beforeTokenCost,
        after: undefined,
      },
    ];
  }

  if (Object.is(beforeTokenCost, afterTokenCost)) {
    return [];
  }

  return [
    {
      section: 'budget',
      label: 'budget.weft:tokenCost',
      change: 'delta',
      before: beforeTokenCost,
      after: afterTokenCost,
    },
  ];
}

function collectConversationDiff(
  beforeReplay: WorkflowReplay,
  afterReplay: WorkflowReplay,
): WorkflowTimelineDiffRow[] {
  const beforeCount = getLargestConversationMessageCount(beforeReplay.checkpoint.locals);
  const afterCount = getLargestConversationMessageCount(afterReplay.checkpoint.locals);

  if (Object.is(beforeCount, afterCount)) {
    return [];
  }

  return [
    {
      section: 'conversation',
      label: 'conversation.messages',
      change: 'delta',
      before: beforeCount,
      after: afterCount,
    },
  ];
}

export function buildWorkflowTimelineDiff(
  beforeReplay: WorkflowReplay,
  afterReplay: WorkflowReplay,
): WorkflowTimelineDiffRow[] {
  const rows: WorkflowTimelineDiffRow[] = [];

  collectValueDiffs(
    'locals',
    'locals',
    presentValue(beforeReplay.checkpoint.locals),
    presentValue(afterReplay.checkpoint.locals),
    rows,
  );
  collectValueDiffs(
    'searchAttributes',
    'searchAttributes',
    presentValue(getGenericSearchAttributes(beforeReplay.checkpoint.searchAttributes)),
    presentValue(getGenericSearchAttributes(afterReplay.checkpoint.searchAttributes)),
    rows,
  );

  return [
    ...rows,
    ...collectBudgetDiff(beforeReplay, afterReplay),
    ...collectConversationDiff(beforeReplay, afterReplay),
  ];
}

function getTimelineDiffValueFormatter(value: unknown): () => string {
  if (value === undefined) return () => '-';
  if (value === null) return () => 'null';
  if (typeof value === 'string') return () => value;
  if (typeof value === 'number' || typeof value === 'boolean') return () => String(value);
  if (typeof value === 'bigint' || typeof value === 'symbol') return () => String(value);
  if (typeof value === 'function') return () => '[function]';

  return () => stringifyTimelineDiffValue(value);
}

function stringifyTimelineDiffValue(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? '[unserializable]' : serialized;
  } catch {
    return '[unserializable]';
  }
}

export function formatTimelineDiffValue(value: unknown): string {
  return getTimelineDiffValueFormatter(value)();
}
