import type { Engine } from '../core/engine.ts';
import { RegistrySchemaConversionError, buildRegistrySnapshot } from '../core/registry-snapshot.ts';
import type { ListFilter } from '../core/types.ts';
import {
  McpToolExecutionError,
  applyPrincipalTenantToInput,
  assertScope,
  getVisibleWorkflowState,
  listVisibleWorkflows,
  type McpAccessContext,
} from './access.ts';
import type { McpSession } from './session.ts';

/** MCP tool definition. */
export type McpToolDefinition = {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
};

/** Result shape returned by MCP `tools/call`. */
export type McpToolResult = {
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>;
  readonly isError?: boolean;
};

type ToolCallContext = McpAccessContext & {
  readonly session: McpSession;
  readonly requestId: unknown;
};

type ToolImplementation = {
  readonly definition: McpToolDefinition;
  readonly call: (argumentsValue: unknown, context: ToolCallContext) => Promise<unknown>;
};

/** Build deterministic MCP tool definitions for the current engine registry. */
export function listMcpTools(engine: Engine): McpToolDefinition[] {
  return buildToolImplementations(engine).map((tool) => tool.definition);
}

/** Invoke an MCP tool and shape application failures as tool errors. */
export async function callMcpTool(
  name: string,
  argumentsValue: unknown,
  context: ToolCallContext,
): Promise<McpToolResult> {
  const tool = buildToolImplementations(context.engine).find(
    (candidate) => candidate.definition.name === name,
  );
  if (tool === undefined) {
    return toolError(`Unknown tool: ${name}`);
  }

  try {
    const value = await tool.call(argumentsValue ?? {}, context);
    return toolSuccess(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError(message);
  }
}

function buildToolImplementations(engine: Engine): ToolImplementation[] {
  const tools = [...builtInTools()];
  let snapshot: ReturnType<typeof buildRegistrySnapshot>;
  try {
    snapshot = buildRegistrySnapshot(engine);
  } catch (error) {
    if (error instanceof RegistrySchemaConversionError) throw error;
    throw error;
  }

  const usedNames = new Set(tools.map((tool) => tool.definition.name));
  for (const [workflowType, entry] of Object.entries(snapshot.workflows)) {
    if (entry.inputSchema === undefined) continue;
    const name = uniqueToolName(toolNameFromWorkflowType(workflowType), usedNames);
    usedNames.add(name);
    tools.push({
      definition: {
        name,
        title: workflowType,
        description: entry.description ?? `Run Weft workflow ${workflowType}.`,
        inputSchema: entry.inputSchema,
      },
      call: async (argumentsValue, context) => {
        assertScope(context, 'workflows:write', 'Calling workflow tools');
        const input = applyPrincipalTenantToInput(context.principal, argumentsValue);
        const handle = await context.engine.start(workflowType, input);
        context.session.trackRequest(context.requestId, handle.id);
        try {
          const result = await handle.result();
          return { workflowId: handle.id, result };
        } finally {
          context.session.untrackRequest(context.requestId);
        }
      },
    });
  }

  return tools.toSorted((left, right) => (left.definition.name < right.definition.name ? -1 : 1));
}

function builtInTools(): ToolImplementation[] {
  return [
    {
      definition: {
        name: 'start_workflow',
        description: 'Start a Weft workflow and return its workflow id.',
        inputSchema: objectSchema(
          {
            type: { type: 'string' },
            input: {},
            id: { type: 'string' },
          },
          ['type'],
        ),
      },
      call: async (argumentsValue, context) => {
        assertScope(context, 'workflows:write', 'Starting workflows');
        const args = requireObject(argumentsValue);
        const type = requireString(args['type'], 'type');
        const input = applyPrincipalTenantToInput(context.principal, args['input'] ?? {});
        const options = typeof args['id'] === 'string' ? { id: args['id'] } : undefined;
        const handle = await context.engine.start(type, input, options);
        return { workflowId: handle.id };
      },
    },
    {
      definition: {
        name: 'signal_workflow',
        description: 'Send a signal to a Weft workflow.',
        inputSchema: objectSchema(
          {
            workflowId: { type: 'string' },
            name: { type: 'string' },
            payload: {},
          },
          ['workflowId', 'name'],
        ),
      },
      call: async (argumentsValue, context) => {
        assertScope(context, 'signals:write', 'Signalling workflows');
        const args = requireObject(argumentsValue);
        const workflowId = requireString(args['workflowId'], 'workflowId');
        await requireVisibleWorkflow(context, workflowId);
        await context.engine.signal(
          workflowId,
          requireString(args['name'], 'name'),
          args['payload'],
        );
        return { ok: true };
      },
    },
    {
      definition: {
        name: 'update_workflow',
        description: 'Run an update handler on a Weft workflow.',
        inputSchema: objectSchema(
          {
            workflowId: { type: 'string' },
            name: { type: 'string' },
            payload: {},
          },
          ['workflowId', 'name'],
        ),
      },
      call: async (argumentsValue, context) => {
        assertScope(context, 'updates:write', 'Updating workflows');
        const args = requireObject(argumentsValue);
        const workflowId = requireString(args['workflowId'], 'workflowId');
        await requireVisibleWorkflow(context, workflowId);
        const result = await context.engine.update(
          workflowId,
          requireString(args['name'], 'name'),
          args['payload'],
        );
        return { result };
      },
    },
    {
      definition: {
        name: 'query_workflow',
        description: 'Run a query handler on a Weft workflow.',
        inputSchema: objectSchema(
          {
            workflowId: { type: 'string' },
            name: { type: 'string' },
            input: {},
          },
          ['workflowId', 'name'],
        ),
      },
      call: async (argumentsValue, context) => {
        assertScope(context, 'queries:read', 'Querying workflows');
        const args = requireObject(argumentsValue);
        const workflowId = requireString(args['workflowId'], 'workflowId');
        await requireVisibleWorkflow(context, workflowId);
        const result = await context.engine.query(
          workflowId,
          requireString(args['name'], 'name'),
          args['input'],
        );
        return { result };
      },
    },
    {
      definition: {
        name: 'cancel_workflow',
        description: 'Cancel a Weft workflow.',
        inputSchema: objectSchema({ workflowId: { type: 'string' } }, ['workflowId']),
      },
      call: async (argumentsValue, context) => {
        assertScope(context, 'workflows:write', 'Cancelling workflows');
        const workflowId = requireString(requireObject(argumentsValue)['workflowId'], 'workflowId');
        await requireVisibleWorkflow(context, workflowId);
        await context.engine.cancel(workflowId);
        return { ok: true };
      },
    },
    {
      definition: {
        name: 'list_workflows',
        description: 'List visible Weft workflows.',
        inputSchema: objectSchema({
          status: {},
          type: { type: 'string' },
          limit: { type: 'number' },
          offset: { type: 'number' },
        }),
      },
      call: async (argumentsValue, context) => {
        assertScope(context, 'workflows:read', 'Listing workflows');
        const filter = { ...requireObject(argumentsValue) } as ListFilter;
        const result = await listVisibleWorkflows(context.engine, context.principal, filter);
        return result;
      },
    },
    {
      definition: {
        name: 'get_workflow_state',
        description: 'Read visible Weft workflow state.',
        inputSchema: objectSchema({ workflowId: { type: 'string' } }, ['workflowId']),
      },
      call: async (argumentsValue, context) => {
        assertScope(context, 'workflows:read', 'Reading workflow state');
        const workflowId = requireString(requireObject(argumentsValue)['workflowId'], 'workflowId');
        return await requireVisibleWorkflow(context, workflowId);
      },
    },
  ];
}

async function requireVisibleWorkflow(context: McpAccessContext, workflowId: string) {
  const state = await getVisibleWorkflowState(context.engine, context.principal, workflowId);
  if (state === null) throw new McpToolExecutionError(`Workflow "${workflowId}" not found`);
  return state;
}

function toolSuccess(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function toolError(message: string): McpToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function requireObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new McpToolExecutionError('Tool arguments must be a JSON object');
}

function requireString(value: unknown, field: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  throw new McpToolExecutionError(`Tool argument "${field}" must be a non-empty string`);
}

function objectSchema(
  properties: Record<string, unknown>,
  required: ReadonlyArray<string> = [],
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required: [...required],
    additionalProperties: false,
  };
}

function toolNameFromWorkflowType(workflowType: string): string {
  const normalized = workflowType
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '');
  if (/^[a-z][a-z0-9_]*$/.test(normalized)) return normalized;
  return `workflow_${normalized || 'unnamed'}`;
}

function uniqueToolName(baseName: string, usedNames: ReadonlySet<string>): string {
  if (!usedNames.has(baseName)) return baseName;
  let suffix = 2;
  while (usedNames.has(`${baseName}_${String(suffix)}`)) suffix += 1;
  return `${baseName}_${String(suffix)}`;
}
