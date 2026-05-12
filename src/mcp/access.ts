import type { Engine } from '../core/engine.ts';
import type { ListFilter, PaginatedResult, WorkflowState, WorkflowSummary } from '../core/types.ts';
import type { AuthorizationScope } from '../server/authorization-scope.ts';
import { isAuthenticated, type Principal } from '../server/principal.ts';

/** Execution context shared by MCP tools and resources. */
export type McpAccessContext = {
  readonly engine: Engine;
  readonly principal: Principal;
  readonly authRequired: boolean;
};

/** Error surfaced as a tool-level failure rather than a protocol failure. */
export class McpToolExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpToolExecutionError';
  }
}

/** Return the tenant constraint carried by a principal, if any. */
export function principalTenantId(principal: Principal): string | undefined {
  if (!isAuthenticated(principal)) return undefined;
  const tenantId = principal.tenantId?.trim();
  return tenantId === undefined || tenantId.length === 0 ? undefined : tenantId;
}

/** Assert that the principal has a scope when authentication is enabled. */
export function assertScope(
  context: McpAccessContext,
  scope: AuthorizationScope,
  action: string,
): void {
  if (!context.authRequired) return;
  if (!isAuthenticated(context.principal)) {
    throw new McpToolExecutionError(`${action} requires authentication`);
  }
  if (!context.principal.hasScope(scope)) {
    throw new McpToolExecutionError(`${action} requires ${scope}`);
  }
}

/** True when a workflow state can be observed or mutated by a principal. */
export function canAccessWorkflowState(principal: Principal, state: WorkflowState): boolean {
  const tenantId = principalTenantId(principal);
  if (tenantId === undefined) return true;
  return state.tenant?.id === tenantId;
}

/** Load a workflow and apply session tenant scoping. */
export async function getVisibleWorkflowState(
  engine: Engine,
  principal: Principal,
  workflowId: string,
): Promise<WorkflowState | null> {
  const state = await engine.get(workflowId);
  if (state === null) return null;
  return canAccessWorkflowState(principal, state) ? state : null;
}

/** List workflows and apply tenant visibility when the engine list API cannot. */
export async function listVisibleWorkflows(
  engine: Engine,
  principal: Principal,
  filter?: ListFilter,
): Promise<PaginatedResult<WorkflowSummary>> {
  const result = await engine.list(filter);
  const tenantId = principalTenantId(principal);
  if (tenantId === undefined) return result;

  const visible: WorkflowSummary[] = [];
  for (const item of result.items) {
    const state = await engine.get(item.id);
    if (state?.tenant?.id === tenantId) visible.push(item);
  }

  return {
    ...result,
    items: visible,
    total: visible.length,
  };
}

/** Inject or verify the session tenant on object-shaped workflow input. */
export function applyPrincipalTenantToInput(principal: Principal, input: unknown): unknown {
  const tenantId = principalTenantId(principal);
  if (tenantId === undefined) return input;
  if (!isJsonObject(input)) {
    throw new McpToolExecutionError('Tenant-scoped workflow input must be a JSON object');
  }
  const existing = input['tenantId'];
  if (existing !== undefined && existing !== tenantId) {
    throw new McpToolExecutionError(
      'Workflow input tenantId does not match the MCP session tenant',
    );
  }
  return { ...input, tenantId };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
