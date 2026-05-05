import type { ActivityMetadata, ActivityRegistry } from '../../core/activity-registry.ts';

/**
 * Catalog-shaped activity metadata for discovery and code generation.
 *
 * Activities are dispatchable units, not standalone user-facing operations.
 * This adapter intentionally returns metadata only; it does not produce
 * executable `OperationDefinition` values.
 */
export type CatalogActivityDefinition = ActivityMetadata;

export function catalogActivity(metadata: ActivityMetadata): CatalogActivityDefinition {
  return {
    name: metadata.name,
    queue: metadata.queue,
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    ...(metadata.tags === undefined ? {} : { tags: [...metadata.tags] }),
    ...(metadata.inputSchema === undefined ? {} : { inputSchema: metadata.inputSchema }),
    ...(metadata.outputSchema === undefined ? {} : { outputSchema: metadata.outputSchema }),
    ...(metadata.retry === undefined ? {} : { retry: metadata.retry }),
    ...(metadata.timeout === undefined ? {} : { timeout: metadata.timeout }),
    ...(metadata.idempotent === undefined ? {} : { idempotent: metadata.idempotent }),
  };
}

export function catalogActivities(registry: ActivityRegistry): CatalogActivityDefinition[] {
  return registry.listDefinitions().map(catalogActivity);
}
