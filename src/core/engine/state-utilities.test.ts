import { describe, expect, it } from 'bun:test';

import type { ScheduleState, WorkflowState } from '../types.ts';
import {
  createTerminalCleanupTimerId,
  encodedValuesEqual,
  getTimelineReviewArtifactType,
  intersectIdentifierSets,
  matchesListFilter,
  matchesScheduleFilter,
  normalizeForkStep,
  normalizeValueForEncodedComparison,
  parseTerminalCleanupTimerId,
  sanitizeCheckpointSearchAttributes,
  sanitizeTimelineSummary,
} from './state-utilities.ts';

function createWorkflowState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    createdAt: 1,
    id: 'workflow-state',
    input: null,
    startedAt: 1,
    status: 'running',
    type: 'workflow',
    updatedAt: 1,
    version: '1',
    ...overrides,
  };
}

function createScheduleState(overrides: Partial<ScheduleState> = {}): ScheduleState {
  return {
    backfills: [],
    catchupWindow: 0,
    createdAt: 1,
    cronExpression: '* * * * *',
    id: 'schedule-state',
    input: null,
    nextFireAt: 60_000,
    status: 'active',
    updatedAt: 1,
    workflowType: 'workflow',
    ...overrides,
  } as ScheduleState;
}

describe('engine state utilities', () => {
  it('returns undefined for review artifacts without a type field', () => {
    expect(getTimelineReviewArtifactType(null)).toBeUndefined();
    expect(getTimelineReviewArtifactType({ value: 'missing type' })).toBeUndefined();
    expect(getTimelineReviewArtifactType({ type: 'text' })).toBe('text');
  });

  it('sanitizes non-record checkpoint search attributes to an empty object', () => {
    expect(sanitizeCheckpointSearchAttributes('not-a-record')).toEqual({});
  });

  it('passes through undefined timeline summaries and normalizes JSON summaries', () => {
    expect(sanitizeTimelineSummary(undefined)).toBeUndefined();
    expect(sanitizeTimelineSummary('{"b":2,"a":1}')).toBe('{"b":2,"a":1}');
    expect(sanitizeTimelineSummary('not json')).toBe('not json');
  });

  it('rejects invalid fork steps', () => {
    expect(() => normalizeForkStep(-1)).toThrow(
      'options.fromStep must be a non-negative safe integer',
    );
    expect(() => normalizeForkStep(1.5)).toThrow(
      'options.fromStep must be a non-negative safe integer',
    );
  });

  it('intersects identifier sets and returns null for an empty set list', () => {
    expect(intersectIdentifierSets([])).toBeNull();
    expect(
      intersectIdentifierSets([new Set(['a', 'b', 'c']), new Set(['b', 'c']), new Set(['c'])]),
    ).toEqual(new Set(['c']));
  });

  it('applies constrained identifier, status, tag, and type list filters', () => {
    const state = createWorkflowState({ tags: ['critical'] });

    expect(matchesListFilter(state, undefined, new Set(['other-workflow']), undefined)).toBe(false);
    expect(matchesListFilter(state, { status: 'completed' }, null, undefined)).toBe(false);
    expect(matchesListFilter(state, undefined, null, ['missing'])).toBe(false);
    expect(matchesListFilter(state, { type: 'other' }, null, undefined)).toBe(false);
    expect(
      matchesListFilter(state, { status: ['running'] }, new Set(['workflow-state']), ['critical']),
    ).toBe(true);
  });

  it('normalizes arrays and object keys for encoded comparison', () => {
    expect(normalizeValueForEncodedComparison([{ b: 2, a: 1 }])).toEqual([{ a: 1, b: 2 }]);
    expect(encodedValuesEqual({ b: 2, a: 1 }, { a: 1, b: 2 })).toBe(true);
    expect(encodedValuesEqual([1], [1, 2])).toBe(false);
    expect(encodedValuesEqual({ value: 1 }, { value: 2 })).toBe(false);
  });

  it('applies tenant, status, and workflow type schedule filters', () => {
    const tenantSchedule = createScheduleState({ tenant: { id: 'tenant-a' } });
    const publicSchedule = createScheduleState();

    expect(matchesScheduleFilter(tenantSchedule, undefined)).toBe(false);
    expect(matchesScheduleFilter(tenantSchedule, { tenantId: 'tenant-b' })).toBe(false);
    expect(matchesScheduleFilter(publicSchedule, { tenantId: 'tenant-a' })).toBe(false);
    expect(matchesScheduleFilter(publicSchedule, { status: 'paused' })).toBe(false);
    expect(matchesScheduleFilter(publicSchedule, { workflowType: 'other' })).toBe(false);
    expect(
      matchesScheduleFilter(tenantSchedule, { tenantId: 'tenant-a', status: ['active'] }),
    ).toBe(true);
  });

  it('rejects every indexed list-filter dimension independently', () => {
    const base = createWorkflowState({
      tenant: { id: 'tenant-a' },
      createdAt: 100,
      updatedAt: 200,
      executionDeadline: 300,
      failureCategory: 'application',
      tags: ['critical'],
    });

    // status (single + array variants)
    expect(matchesListFilter(base, { status: 'completed' }, null, undefined)).toBe(false);
    expect(matchesListFilter(base, { status: ['completed', 'failed'] }, null, undefined)).toBe(
      false,
    );

    // type
    expect(matchesListFilter(base, { type: 'other-workflow' }, null, undefined)).toBe(false);

    // tenantId (single + array)
    expect(matchesListFilter(base, { tenantId: 'tenant-b' }, null, undefined)).toBe(false);
    expect(matchesListFilter(base, { tenantId: ['tenant-b', 'tenant-c'] }, null, undefined)).toBe(
      false,
    );
    // missing tenant on state rejects tenantId filter
    expect(
      matchesListFilter(createWorkflowState(), { tenantId: 'tenant-a' }, null, undefined),
    ).toBe(false);

    // idPrefix
    expect(matchesListFilter(base, { idPrefix: 'zzz' }, null, undefined)).toBe(false);

    // createdAt range
    expect(matchesListFilter(base, { createdAt: { gt: 100 } }, null, undefined)).toBe(false);
    expect(matchesListFilter(base, { createdAt: { lt: 100 } }, null, undefined)).toBe(false);

    // updatedAt range
    expect(matchesListFilter(base, { updatedAt: { gt: 200 } }, null, undefined)).toBe(false);

    // executionDeadline range
    expect(matchesListFilter(base, { executionDeadline: { gt: 300 } }, null, undefined)).toBe(
      false,
    );
    // missing executionDeadline on state rejects executionDeadline filter
    expect(
      matchesListFilter(createWorkflowState(), { executionDeadline: { gte: 0 } }, null, undefined),
    ).toBe(false);

    // failureCategory (single + array)
    expect(matchesListFilter(base, { failureCategory: 'system' }, null, undefined)).toBe(false);
    expect(
      matchesListFilter(base, { failureCategory: ['system', 'timeout'] }, null, undefined),
    ).toBe(false);

    // tag filter (normalized tag filters argument)
    expect(matchesListFilter(base, undefined, null, ['missing'])).toBe(false);

    // constrained id set
    expect(matchesListFilter(base, undefined, new Set(['other-id']), undefined)).toBe(false);

    // passes when every dimension matches
    expect(
      matchesListFilter(
        base,
        {
          status: ['running'],
          type: 'workflow',
          tenantId: ['tenant-a'],
          idPrefix: 'workflow',
          createdAt: { gte: 100, lte: 100 },
          updatedAt: { gte: 200, lte: 200 },
          executionDeadline: { gte: 300, lte: 300 },
          failureCategory: 'application',
        },
        new Set([base.id]),
        ['critical'],
      ),
    ).toBe(true);
  });

  it('rejects every indexed schedule-filter dimension independently', () => {
    const tenantSchedule = createScheduleState({ tenant: { id: 'tenant-a' } });
    const publicSchedule = createScheduleState();

    // tenantId mismatch
    expect(matchesScheduleFilter(tenantSchedule, undefined)).toBe(false);
    expect(matchesScheduleFilter(tenantSchedule, { tenantId: 'tenant-b' })).toBe(false);
    // tenant-less schedule rejects when a tenantId filter is provided
    expect(matchesScheduleFilter(publicSchedule, { tenantId: 'tenant-a' })).toBe(false);

    // status (single + array)
    expect(matchesScheduleFilter(publicSchedule, { status: 'paused' })).toBe(false);
    expect(matchesScheduleFilter(publicSchedule, { status: ['paused', 'cancelled'] })).toBe(false);

    // workflowType
    expect(matchesScheduleFilter(publicSchedule, { workflowType: 'other' })).toBe(false);

    // passes when every dimension matches
    expect(
      matchesScheduleFilter(tenantSchedule, {
        tenantId: 'tenant-a',
        status: ['active'],
        workflowType: 'workflow',
      }),
    ).toBe(true);
    expect(matchesScheduleFilter(publicSchedule, { status: 'active' })).toBe(true);
  });

  it('parses terminal cleanup timer identifiers', () => {
    const fullTimerId = createTerminalCleanupTimerId(true, 'token-1');
    const preserveTimerId = createTerminalCleanupTimerId(false, 'token-2');

    expect(parseTerminalCleanupTimerId(fullTimerId)).toEqual({
      includeOutputArtifacts: true,
      terminalCleanupToken: 'token-1',
    });
    expect(parseTerminalCleanupTimerId(preserveTimerId)).toEqual({
      includeOutputArtifacts: false,
      terminalCleanupToken: 'token-2',
    });
    expect(parseTerminalCleanupTimerId('terminal-cleanup:full:')).toBeNull();
    expect(parseTerminalCleanupTimerId('not-a-cleanup-timer')).toBeNull();
  });
});
