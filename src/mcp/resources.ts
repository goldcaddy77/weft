import type { ListFilter } from '../core/types.ts';
import {
  assertScope,
  getVisibleWorkflowState,
  listVisibleWorkflows,
  type McpAccessContext,
} from './access.ts';
import type { McpSession } from './session.ts';

/** MCP resource definition. */
export type McpResourceDefinition = {
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
};

/** MCP resource template definition. */
export type McpResourceTemplate = {
  readonly uriTemplate: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly mimeType: string;
};

/** MCP resource-read result. */
export type McpResourceReadResult = {
  readonly contents: ReadonlyArray<{
    readonly uri: string;
    readonly mimeType: string;
    readonly text: string;
  }>;
};

/** Return the static resource templates Weft exposes through MCP. */
export function listMcpResourceTemplates(): McpResourceTemplate[] {
  return [
    {
      uriTemplate: 'weft://workflows/{workflowId}/state',
      name: 'workflow_state',
      title: 'Workflow state',
      description: 'Read the current state for a Weft workflow.',
      mimeType: 'application/json',
    },
    {
      uriTemplate: 'weft://workflows/{workflowId}/events',
      name: 'workflow_events',
      title: 'Workflow events',
      description: 'Read the event log for a Weft workflow.',
      mimeType: 'application/json',
    },
    {
      uriTemplate: 'weft://workflows/{workflowId}/checkpoints',
      name: 'workflow_checkpoints',
      title: 'Workflow checkpoints',
      description: 'Read checkpoint history summaries for a Weft workflow.',
      mimeType: 'application/json',
    },
    {
      uriTemplate: 'weft://workflows/search{?status,type,limit,offset}',
      name: 'workflow_search',
      title: 'Workflow search',
      description: 'List visible Weft workflows using query filters.',
      mimeType: 'application/json',
    },
  ];
}

/** List visible workflow state resources. */
export async function listMcpResources(
  context: McpAccessContext,
): Promise<McpResourceDefinition[]> {
  assertScope(context, 'workflows:read', 'Listing workflow resources');
  const workflows = await listVisibleWorkflows(context.engine, context.principal, {});
  return workflows.items.map((workflow) => ({
    uri: `weft://workflows/${workflow.id}/state`,
    name: `workflow_${workflow.id}`,
    title: `${workflow.type} workflow ${workflow.id}`,
    description: `Current state for workflow ${workflow.id}.`,
    mimeType: 'application/json',
  }));
}

/** Read a visible Weft MCP resource. */
export async function readMcpResource(
  uri: string,
  context: McpAccessContext,
): Promise<McpResourceReadResult | null> {
  assertScope(context, 'workflows:read', 'Reading workflow resources');
  const parsed = parseWeftResourceUri(uri);
  if (parsed === null) return null;

  if (parsed.kind === 'search') {
    const result = await listVisibleWorkflows(context.engine, context.principal, parsed.filter);
    return jsonResource(uri, result);
  }

  const state = await getVisibleWorkflowState(context.engine, context.principal, parsed.workflowId);
  if (state === null) return null;

  switch (parsed.kind) {
    case 'state':
      return jsonResource(uri, state);
    case 'events':
      assertScope(context, 'events:read', 'Reading workflow events');
      return jsonResource(uri, { events: await context.engine.getEvents(parsed.workflowId) });
    case 'checkpoints':
      return jsonResource(uri, {
        checkpoints: await context.engine.listCheckpoints(parsed.workflowId),
      });
  }
}

/** Subscribe to updates for a visible resource. */
export async function subscribeMcpResource(
  uri: string,
  session: McpSession,
  context: McpAccessContext,
): Promise<boolean> {
  const result = await readMcpResource(uri, context);
  if (result === null) return false;
  session.subscriptions.add(uri);
  return true;
}

/** Remove a resource subscription. */
export function unsubscribeMcpResource(uri: string, session: McpSession): void {
  session.subscriptions.delete(uri);
}

function jsonResource(uri: string, value: unknown): McpResourceReadResult {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(value),
      },
    ],
  };
}

type ParsedResourceUri =
  | { readonly kind: 'state'; readonly workflowId: string }
  | { readonly kind: 'events'; readonly workflowId: string }
  | { readonly kind: 'checkpoints'; readonly workflowId: string }
  | { readonly kind: 'search'; readonly filter: ListFilter };

function parseWeftResourceUri(uri: string): ParsedResourceUri | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== 'weft:' || url.hostname !== 'workflows') return null;
  if (url.pathname === '/search') {
    return { kind: 'search', filter: filterFromSearchParams(url.searchParams) };
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const [workflowId, resourceKind] = parts;
  if (!workflowId) return null;
  if (resourceKind === 'state' || resourceKind === 'events' || resourceKind === 'checkpoints') {
    return { kind: resourceKind, workflowId };
  }
  return null;
}

function filterFromSearchParams(searchParams: URLSearchParams): ListFilter {
  const filter: ListFilter = {};
  const status = searchParams.getAll('status');
  if (status.length === 1) filter.status = status[0] as never;
  if (status.length > 1) filter.status = status as never;
  const type = searchParams.get('type');
  if (type !== null) filter.type = type;
  const limit = coerceNonNegativeInteger(searchParams.get('limit'));
  if (limit !== undefined) filter.limit = limit;
  const offset = coerceNonNegativeInteger(searchParams.get('offset'));
  if (offset !== undefined) filter.offset = offset;
  return filter;
}

function coerceNonNegativeInteger(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}
