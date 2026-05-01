/**
 * Workflow, agent, and tool version tuple utilities.
 *
 * Captures a `(workflowVersion, agentVersion, toolVersions[])` tuple on every
 * event-log entry and provides diff utilities to detect mismatches between
 * stored tuples and currently-registered definitions when resuming workflows.
 *
 * @module core/workflow-version-tuple
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Version tuple captured at workflow start and on every event-log entry. */
export type WorkflowVersionTuple = {
  workflowVersion: string;
  agentVersion?: string;
  /** Sorted `"${name}@${version}"` strings, one per tool. */
  toolVersions?: string[];
};

/** A single tool-level version change surfaced by {@link diffWorkflowVersionTuples}. */
export type WorkflowToolVersionChange =
  | { tool: string; change: 'added'; to: string }
  | { tool: string; change: 'removed'; from: string }
  | { tool: string; change: 'changed'; from: string; to: string };

/** Structured field-level diff between two {@link WorkflowVersionTuple}s. */
export type WorkflowVersionDiff = {
  workflowVersion?: [string, string];
  agentVersion?: [string, string];
  toolVersions?: WorkflowToolVersionChange[];
};

// ---------------------------------------------------------------------------
// collectToolVersions
// ---------------------------------------------------------------------------

/**
 * Collect sorted `"${name}@${version}"` version strings from a tool array.
 *
 * Each element must expose `definition.name` and an optional `version`.
 * Missing versions default to `"0.0.0"`. The returned array is sorted
 * alphabetically so comparisons are order-independent.
 */
export function collectToolVersions(
  tools: Array<{ definition: { name: string }; version?: string }>,
): string[] {
  return tools
    .map((tool) => {
      const name = tool.definition.name;
      if (!name) throw new Error(`collectToolVersions: tool is missing a required name field`);
      return `${name}@${tool.version ?? '0.0.0'}`;
    })
    .toSorted();
}

// ---------------------------------------------------------------------------
// diffWorkflowVersionTuples
// ---------------------------------------------------------------------------

/**
 * Compare two {@link WorkflowVersionTuple}s and return structured field-level diffs.
 *
 * Only fields that actually differ are included in the output. An empty
 * object means the tuples are identical.
 */
// oxlint-disable-next-line complexity -- ID:core-workflow-version-tuple-diff-workflow-version-tuples-complexity
export function diffWorkflowVersionTuples(
  stored: WorkflowVersionTuple,
  registered: WorkflowVersionTuple,
): WorkflowVersionDiff {
  const diff: WorkflowVersionDiff = {};

  // Workflow version
  if (stored.workflowVersion !== registered.workflowVersion) {
    diff.workflowVersion = [stored.workflowVersion, registered.workflowVersion];
  }

  // Agent version
  const storedAgent = stored.agentVersion ?? '0.0.0';
  const registeredAgent = registered.agentVersion ?? '0.0.0';
  if (storedAgent !== registeredAgent) {
    diff.agentVersion = [storedAgent, registeredAgent];
  }

  // Tool versions — parse "name@version" strings into a map for diffing
  const storedTools = parseToolVersionMap(stored.toolVersions ?? []);
  const registeredTools = parseToolVersionMap(registered.toolVersions ?? []);

  const allToolNames = new Set([...storedTools.keys(), ...registeredTools.keys()]);
  const toolChanges: WorkflowToolVersionChange[] = [];

  for (const name of allToolNames) {
    const from = storedTools.get(name);
    const to = registeredTools.get(name);

    if (from === undefined && to !== undefined) {
      toolChanges.push({ tool: name, change: 'added', to });
    } else if (from !== undefined && to === undefined) {
      toolChanges.push({ tool: name, change: 'removed', from });
    } else if (from !== undefined && to !== undefined && from !== to) {
      toolChanges.push({ tool: name, change: 'changed', from, to });
    }
  }

  if (toolChanges.length > 0) {
    diff.toolVersions = toolChanges;
  }

  return diff;
}

// ---------------------------------------------------------------------------
// formatWorkflowVersionDiff
// ---------------------------------------------------------------------------

/**
 * Format a human-readable summary of a {@link WorkflowVersionDiff} for error messages.
 *
 * Returns an empty string when the diff has no changes.
 */
export function formatWorkflowVersionDiff(diff: WorkflowVersionDiff): string {
  const lines: string[] = [];

  if (diff.workflowVersion) {
    const [from, to] = diff.workflowVersion;
    lines.push(`  - workflow version: ${from} → ${to}`);
  }

  if (diff.agentVersion) {
    const [from, to] = diff.agentVersion;
    lines.push(`  - agent version: ${from} → ${to}`);
  }

  if (diff.toolVersions) {
    for (const change of diff.toolVersions) {
      switch (change.change) {
        case 'added':
          lines.push(`  - tool \`${change.tool}\` added (version: ${change.to})`);
          break;
        case 'removed':
          lines.push(`  - tool \`${change.tool}\` removed (was: ${change.from})`);
          break;
        case 'changed':
          lines.push(`  - tool \`${change.tool}\` version: ${change.from} → ${change.to}`);
          break;
      }
    }
  }

  if (lines.length === 0) return '';
  return `\nVersion tuple changes:\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Parse `"name@version"` strings into a Map for O(1) lookups. */
function parseToolVersionMap(versions: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of versions) {
    const atIndex = entry.lastIndexOf('@');
    if (atIndex > 0) {
      map.set(entry.slice(0, atIndex), entry.slice(atIndex + 1));
    }
  }
  return map;
}
