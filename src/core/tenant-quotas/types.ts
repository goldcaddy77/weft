import type { BatchOperation } from '../../storage/interface.ts';
import type { WorkflowStatus } from '../types.ts';

export type NormalizedTenantQuotaOptions = {
  maxConcurrentWorkflows: number | null;
  maxStorageBytes: number | null;
  maxWorkflowCreationRate: {
    count: number;
    windowMilliseconds: number;
  } | null;
};

export type WorkflowCreationRateRecord = {
  timestamps: number[];
};

export type TenantActiveWorkflowRecord = {
  workflowIds: string[];
};

export type TenantStorageUsageRecord = {
  bytes: number;
};

export type DecodedWorkflowTenantRecord = {
  id: string;
  status: WorkflowStatus;
  tenant?: {
    id: string;
  };
};

export type StartAdmissionParameters = {
  tenantId: string;
  workflowId: string;
  startOperations: BatchOperation[];
  estimatedStorageBytes: number;
};

export type TerminalTransitionParameters = {
  tenantId: string;
  workflowId: string;
  operations: BatchOperation[];
};
