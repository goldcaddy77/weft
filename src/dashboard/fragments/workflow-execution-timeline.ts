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

const missingValue: DiffCandidate = { missing: true };

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

function collectValueDiffs(
  section: WorkflowTimelineDiffSection,
  label: string,
  beforeValue: DiffCandidate,
  afterValue: DiffCandidate,
  rows: WorkflowTimelineDiffRow[],
): void {
  if (
    !beforeValue.missing &&
    !afterValue.missing &&
    Object.is(beforeValue.value, afterValue.value)
  ) {
    return;
  }

  if (
    !beforeValue.missing &&
    !afterValue.missing &&
    Array.isArray(beforeValue.value) &&
    Array.isArray(afterValue.value)
  ) {
    const beforeArray = beforeValue.value;
    const afterArray = afterValue.value;
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
    return;
  }

  if (
    !beforeValue.missing &&
    !afterValue.missing &&
    isPlainObjectRecord(beforeValue.value) &&
    isPlainObjectRecord(afterValue.value)
  ) {
    const beforeRecord = beforeValue.value;
    const afterRecord = afterValue.value;
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
    return;
  }

  addLeafDiff(section, label, beforeValue, afterValue, rows);
}

function collectBudgetDiff(
  beforeReplay: WorkflowReplay,
  afterReplay: WorkflowReplay,
): WorkflowTimelineDiffRow[] {
  const beforeTokenCost = readNumber(beforeReplay.checkpoint.searchAttributes['weft:tokenCost']);
  const afterTokenCost = readNumber(afterReplay.checkpoint.searchAttributes['weft:tokenCost']);

  if (
    beforeTokenCost === null ||
    afterTokenCost === null ||
    Object.is(beforeTokenCost, afterTokenCost)
  ) {
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
    presentValue(beforeReplay.checkpoint.searchAttributes),
    presentValue(afterReplay.checkpoint.searchAttributes),
    rows,
  );

  return [
    ...rows,
    ...collectBudgetDiff(beforeReplay, afterReplay),
    ...collectConversationDiff(beforeReplay, afterReplay),
  ];
}

export function formatTimelineDiffValue(value: unknown): string {
  if (value === undefined) {
    return '-';
  }

  if (value === null) {
    return 'null';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    if (typeof value === 'bigint' || typeof value === 'symbol') {
      return value.toString();
    }
    if (typeof value === 'function') {
      return '[function]';
    }
    return '[unserializable]';
  }
}
