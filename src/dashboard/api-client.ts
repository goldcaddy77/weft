/**
 * Typed fetch wrapper for the Weft REST API.
 *
 * All types are declared inline rather than imported from core
 * because the dashboard runs in the browser, not the server.
 *
 * @module dashboard/api-client
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkflowStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed-out';

export interface WorkflowState {
  id: string;
  type: string;
  status: WorkflowStatus;
  input: unknown;
  result?: unknown;
  error?: string;
  version: string;
  createdAt: number;
  updatedAt: number;
  executionDeadline?: number;
}

export interface WorkflowSummary {
  id: string;
  type: string;
  status: WorkflowStatus;
  version: string;
  createdAt: number;
  updatedAt: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface ListFilter {
  status?: WorkflowStatus;
  type?: string;
  limit?: number;
  offset?: number;
}

export interface TenantQuotaMetricUsage {
  used: number;
  limit: number | null;
}

export interface TenantWorkflowCreationRateUsage extends TenantQuotaMetricUsage {
  windowMilliseconds: number | null;
}

export interface TenantQuotaUsage {
  tenantId: string;
  activeWorkflows: TenantQuotaMetricUsage;
  storageBytes: TenantQuotaMetricUsage;
  workflowCreationRate: TenantWorkflowCreationRateUsage;
}

export interface WorkflowEvent {
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface ReviewRequest {
  reviewId: string;
  workflowId: string;
  artifact: unknown;
  reviewType: string;
  reviewers: string[];
  createdAt: number;
}

export interface ReviewDecision {
  decision: 'approved' | 'rejected' | 'needs-changes';
  reviewer: string;
  feedback?: string;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const BASE_PATH = '/v1';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);

  if (options?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${BASE_PATH}${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) {
        message = body.error;
      }
    } catch {
      // Use statusText if body parsing fails
    }
    throw new ApiError(response.status, message);
  }

  // 204 No Content returns no body
  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export class ApiClient {
  /** List workflows with optional filtering. */
  async listWorkflows(filter?: ListFilter): Promise<PaginatedResult<WorkflowSummary>> {
    const params = new URLSearchParams();

    if (filter?.status !== undefined) params.set('status', filter.status);
    if (filter?.type !== undefined) params.set('type', filter.type);
    if (filter?.limit !== undefined) params.set('limit', String(filter.limit));
    if (filter?.offset !== undefined) params.set('offset', String(filter.offset));

    const query = params.toString();
    const path = query ? `/workflows?${query}` : '/workflows';

    return request<PaginatedResult<WorkflowSummary>>(path);
  }

  /** Get the full state of a single workflow. */
  async getWorkflow(id: string): Promise<WorkflowState> {
    return request<WorkflowState>(`/workflows/${encodeURIComponent(id)}`);
  }

  /** Cancel a running workflow. */
  async cancelWorkflow(id: string): Promise<void> {
    return request<void>(`/workflows/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  /** Send a signal to a workflow. */
  async signalWorkflow(id: string, name: string, payload?: unknown): Promise<void> {
    return request<void>(
      `/workflows/${encodeURIComponent(id)}/signal/${encodeURIComponent(name)}`,
      {
        method: 'POST',
        body: JSON.stringify({ payload }),
      },
    );
  }

  /** Get the event history for a workflow. */
  async getWorkflowEvents(id: string): Promise<WorkflowEvent[]> {
    const response = await request<{ events: WorkflowEvent[] }>(
      `/workflows/${encodeURIComponent(id)}/events`,
    );
    return response.events;
  }

  /** Get search attributes for a workflow. */
  async getWorkflowAttributes(id: string): Promise<Record<string, unknown>> {
    return request<Record<string, unknown>>(`/workflows/${encodeURIComponent(id)}/attributes`);
  }

  /** List all pending human review requests. */
  async listPendingReviews(): Promise<ReviewRequest[]> {
    const response = await request<{ items: ReviewRequest[] }>('/reviews');
    return response.items;
  }

  /** Get current quota usage versus configured limits for a tenant. */
  async getTenantQuotaUsage(tenantId: string): Promise<TenantQuotaUsage> {
    return request<TenantQuotaUsage>(`/tenants/${encodeURIComponent(tenantId)}/quota`);
  }

  /** Submit a decision for a pending review. */
  async submitReviewDecision(
    reviewId: string,
    workflowId: string,
    decision: ReviewDecision,
  ): Promise<void> {
    return request<void>(`/reviews/${encodeURIComponent(reviewId)}/decision`, {
      method: 'POST',
      body: JSON.stringify({ ...decision, workflowId }),
    });
  }

  /** Health check. */
  async checkHealth(): Promise<{ status: string }> {
    return request<{ status: string }>('/health');
  }
}
