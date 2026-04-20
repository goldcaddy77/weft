import type { WorkflowSummary } from '../api-client.ts';

/** Collect the unique workflow tags available for dashboard filter chips. */
export function collectWorkflowTags(workflows: readonly WorkflowSummary[]): string[] {
  const tags = new Set<string>();

  for (const workflow of workflows) {
    for (const tag of workflow.tags ?? []) {
      tags.add(tag);
    }
  }

  return [...tags].toSorted((left, right) => left.localeCompare(right));
}

/** Toggle a dashboard tag filter chip on or off with stable ordering. */
export function toggleWorkflowTagSelection(selectedTags: readonly string[], tag: string): string[] {
  const nextTags = new Set(selectedTags);
  if (nextTags.has(tag)) {
    nextTags.delete(tag);
  } else {
    nextTags.add(tag);
  }

  return [...nextTags].toSorted((left, right) => left.localeCompare(right));
}
