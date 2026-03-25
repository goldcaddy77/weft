import { describe, expect, it, mock } from 'bun:test';

import type { BatchOperation } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import {
  DEFAULT_WORKFLOW_VERSION,
  VersionMismatchError,
  buildVersionUpdateOperations,
  checkVersionCompatibility,
  migrateCheckpoint,
} from './versioning.ts';

describe('checkVersionCompatibility', () => {
  it('returns "compatible" when versions are the same', () => {
    expect(checkVersionCompatibility('1.0.0', '1.0.0', false)).toBe('compatible');
    expect(checkVersionCompatibility('2.3.1', '2.3.1', true)).toBe('compatible');
  });

  it('returns "needs-migration" when versions differ and migration is available', () => {
    expect(checkVersionCompatibility('1.0.0', '2.0.0', true)).toBe('needs-migration');
  });

  it('returns "resume-as-is" when versions differ and no migration is available', () => {
    expect(checkVersionCompatibility('1.0.0', '2.0.0', false)).toBe('resume-as-is');
  });
});

describe('migrateCheckpoint', () => {
  it('calls the migrate function with checkpoint data and fromVersion', () => {
    const migrate = mock(() => ({ migrated: true }));
    const checkpoint = { step: 3, locals: { counter: 10 } };

    migrateCheckpoint(checkpoint, '1.0.0', '2.0.0', migrate);

    expect(migrate).toHaveBeenCalledTimes(1);
    expect(migrate).toHaveBeenCalledWith(checkpoint, '1.0.0');
  });

  it('returns the transformed checkpoint from the migrate function', () => {
    const migrate = (data: unknown) => {
      const record = data as Record<string, unknown>;
      return { ...record, newField: 'added' };
    };

    const checkpoint = { step: 5, locals: { value: 42 } };
    const result = migrateCheckpoint(checkpoint, '1.0.0', '2.0.0', migrate);

    expect(result).toEqual({ step: 5, locals: { value: 42 }, newField: 'added' });
  });

  it('allows the migration function to add new fields', () => {
    const migrate = (data: unknown) => {
      const record = data as Record<string, unknown>;
      return {
        ...record,
        featureFlags: ['beta-ui'],
        metadata: { migratedAt: 1234567890 },
      };
    };

    const checkpoint = { step: 1, locals: {} };
    const result = migrateCheckpoint(checkpoint, '0.0.0', '1.0.0', migrate) as Record<
      string,
      unknown
    >;

    expect(result['featureFlags']).toEqual(['beta-ui']);
    expect(result['metadata']).toEqual({ migratedAt: 1234567890 });
  });
});

describe('buildVersionUpdateOperations', () => {
  it('returns PUT operations for checkpoint and workflow state', () => {
    const workflowId = 'wf-abc-123';
    const checkpointBytes = new Uint8Array([1, 2, 3]);
    const newVersion = '2.0.0';
    const workflowStateBytes = new Uint8Array([4, 5, 6]);

    const operations = buildVersionUpdateOperations(
      workflowId,
      checkpointBytes,
      newVersion,
      workflowStateBytes,
    );

    expect(operations).toHaveLength(2);

    const checkpointOperation = operations.find(
      (operation) => operation.type === 'put' && operation.key === KEYS.checkpoint(workflowId),
    );
    expect(checkpointOperation).toBeDefined();
    expect(checkpointOperation!.type).toBe('put');
    expect((checkpointOperation as Extract<BatchOperation, { type: 'put' }>).value).toEqual(
      checkpointBytes,
    );

    const workflowOperation = operations.find(
      (operation) => operation.type === 'put' && operation.key === KEYS.workflow(workflowId),
    );
    expect(workflowOperation).toBeDefined();
    expect(workflowOperation!.type).toBe('put');
    expect((workflowOperation as Extract<BatchOperation, { type: 'put' }>).value).toEqual(
      workflowStateBytes,
    );
  });
});

describe('VersionMismatchError', () => {
  it('includes all version info as properties', () => {
    const error = new VersionMismatchError('wf-123', 'payment-workflow', '1.0.0', '2.0.0');

    expect(error.workflowId).toBe('wf-123');
    expect(error.workflowType).toBe('payment-workflow');
    expect(error.storedVersion).toBe('1.0.0');
    expect(error.registeredVersion).toBe('2.0.0');
  });

  it('has a descriptive error message', () => {
    const error = new VersionMismatchError('wf-456', 'order-workflow', '1.0.0', '3.0.0');

    expect(error.message).toContain('wf-456');
    expect(error.message).toContain('order-workflow');
    expect(error.message).toContain('1.0.0');
    expect(error.message).toContain('3.0.0');
  });

  it('is an instance of Error', () => {
    const error = new VersionMismatchError('wf-789', 'test-workflow', '1.0.0', '2.0.0');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('VersionMismatchError');
  });
});

describe('DEFAULT_WORKFLOW_VERSION', () => {
  it('is "0.0.0"', () => {
    expect(DEFAULT_WORKFLOW_VERSION).toBe('0.0.0');
  });
});
