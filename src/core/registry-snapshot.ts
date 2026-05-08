/**
 * Pure builder that captures a snapshot of the engine's locally-registered
 * workflows and activities, with their JSON Schemas. This is the data source
 * behind the `GET /v1/registry` REST endpoint and (later) the MCP server.
 *
 * The output is a plain object designed to be safe for JSON serialization:
 * keys are inserted in alphabetical (codepoint) order; absent metadata fields
 * are omitted (never `null`, never `{}`); and converter exceptions are
 * re-thrown with the entity name and direction prepended so callers know
 * exactly which registration caused the failure.
 *
 * @module core/registry-snapshot
 */
import type { ActivityMetadata } from './activity-registry.ts';
import type { Engine } from './engine.ts';
import { definitionSchemaToJsonSchema } from './types/definition-schema-to-json.ts';
import type { DefinitionSchema } from './types/definition-schema.ts';
import type { RegisteredWorkflowDefinition } from './types/workflow-registry.ts';

/**
 * Current registry contract version. Future incompatible changes to the
 * snapshot shape must bump this number; the codegen CLI rejects unknown
 * versions with a clear upgrade message.
 */
export const REGISTRY_VERSION = 1;

/** Metadata reported per workflow in a registry snapshot. */
export type RegistryWorkflowEntry = {
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  description?: string;
  tags?: ReadonlyArray<string>;
};

/** Metadata reported per activity in a registry snapshot. */
export type RegistryActivityEntry = {
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  queue?: string;
  description?: string;
};

/**
 * Snapshot of every locally-registered workflow and activity, suitable for
 * serialization as the `GET /v1/registry` response body.
 */
export type RegistrySnapshot = {
  registryVersion: typeof REGISTRY_VERSION;
  workflows: Record<string, RegistryWorkflowEntry>;
  activities: Record<string, RegistryActivityEntry>;
};

/**
 * Build a registry snapshot from an engine's locally-registered workflows
 * and activities. Remote-only activities (those advertised by a remote
 * worker but never registered with the local engine) are excluded by
 * construction — `engine.listActivityDefinitions()` is the only source.
 *
 * Throws if any registered schema fails JSON Schema conversion. The thrown
 * error names the entity (workflow/activity), its registered name, and the
 * direction (`inputSchema`/`outputSchema`) so the caller can locate the
 * offending registration without further introspection.
 */
export function buildRegistrySnapshot(engine: Engine): RegistrySnapshot {
  const workflowDefinitions = engine.listWorkflowDefinitions();
  const activityDefinitions = engine.listActivityDefinitions();

  const sortedWorkflows = workflowDefinitions.toSorted(compareByName('type'));
  const sortedActivities = activityDefinitions.toSorted(compareByName('name'));

  const workflows: Record<string, RegistryWorkflowEntry> = {};
  for (const definition of sortedWorkflows) {
    workflows[definition.type] = buildWorkflowEntry(definition);
  }

  const activities: Record<string, RegistryActivityEntry> = {};
  for (const metadata of sortedActivities) {
    activities[metadata.name] = buildActivityEntry(metadata);
  }

  return {
    registryVersion: REGISTRY_VERSION,
    workflows,
    activities,
  };
}

function buildWorkflowEntry(definition: RegisteredWorkflowDefinition): RegistryWorkflowEntry {
  const entry: RegistryWorkflowEntry = {};
  if (definition.inputSchema !== undefined) {
    entry.inputSchema = convertSchema(
      'workflow',
      definition.type,
      'inputSchema',
      definition.inputSchema,
    );
  }
  if (definition.outputSchema !== undefined) {
    entry.outputSchema = convertSchema(
      'workflow',
      definition.type,
      'outputSchema',
      definition.outputSchema,
    );
  }
  if (definition.description !== undefined) {
    entry.description = definition.description;
  }
  if (definition.tags.length > 0) {
    entry.tags = [...definition.tags];
  }
  return entry;
}

function buildActivityEntry(metadata: ActivityMetadata): RegistryActivityEntry {
  const entry: RegistryActivityEntry = {};
  if (metadata.inputSchema !== undefined) {
    entry.inputSchema = convertSchema(
      'activity',
      metadata.name,
      'inputSchema',
      metadata.inputSchema,
    );
  }
  if (metadata.outputSchema !== undefined) {
    entry.outputSchema = convertSchema(
      'activity',
      metadata.name,
      'outputSchema',
      metadata.outputSchema,
    );
  }
  if (metadata.queue !== undefined) {
    entry.queue = metadata.queue;
  }
  if (metadata.description !== undefined) {
    entry.description = metadata.description;
  }
  return entry;
}

function convertSchema(
  entityKind: 'workflow' | 'activity',
  entityName: string,
  field: 'inputSchema' | 'outputSchema',
  schema: DefinitionSchema,
): Record<string, unknown> {
  try {
    const direction = field === 'inputSchema' ? 'input' : 'output';
    return definitionSchemaToJsonSchema(schema, direction);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Failed to convert ${field} for ${entityKind} "${entityName}": ${reason}`, {
      cause,
    });
  }
}

function compareByName<TKey extends string>(
  key: TKey,
): (left: Record<TKey, string>, right: Record<TKey, string>) => number {
  return (left, right) => {
    const a = left[key];
    const b = right[key];
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  };
}
