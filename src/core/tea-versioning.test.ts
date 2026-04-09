import { describe, expect, it } from 'bun:test';

import {
  collectToolVersions,
  diffTeaVersionTuples,
  formatTeaVersionDiff,
} from './tea-versioning.ts';

// ---------------------------------------------------------------------------
// collectToolVersions
// ---------------------------------------------------------------------------

describe('collectToolVersions', () => {
  it('returns sorted name@version strings', () => {
    const tools = [
      { definition: { name: 'beta' }, version: '2.0.0' },
      { definition: { name: 'alpha' }, version: '1.0.0' },
    ];
    expect(collectToolVersions(tools)).toEqual(['alpha@1.0.0', 'beta@2.0.0']);
  });

  it('defaults missing version to 0.0.0', () => {
    const tools = [{ definition: { name: 'my-tool' } }];
    expect(collectToolVersions(tools)).toEqual(['my-tool@0.0.0']);
  });

  it('throws when a tool has an empty name', () => {
    const tools = [{ definition: { name: '' }, version: '1.0.0' }];
    expect(() => collectToolVersions(tools)).toThrow(
      'collectToolVersions: tool is missing a required name field',
    );
  });

  it('returns empty array for empty input', () => {
    expect(collectToolVersions([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// diffTeaVersionTuples
// ---------------------------------------------------------------------------

describe('diffTeaVersionTuples', () => {
  it('returns empty diff when tuples are identical', () => {
    const tuple = { workflowVersion: '1.0.0', agentVersion: '1.0.0', toolVersions: ['t@1.0.0'] };
    expect(diffTeaVersionTuples(tuple, tuple)).toEqual({});
  });

  it('detects workflow version change', () => {
    const stored = { workflowVersion: '1.0.0' };
    const registered = { workflowVersion: '2.0.0' };
    const diff = diffTeaVersionTuples(stored, registered);
    expect(diff.workflowVersion).toEqual(['1.0.0', '2.0.0']);
  });

  it('detects agent version change', () => {
    const stored = { workflowVersion: '1.0.0', agentVersion: '1.0.0' };
    const registered = { workflowVersion: '1.0.0', agentVersion: '2.0.0' };
    const diff = diffTeaVersionTuples(stored, registered);
    expect(diff.agentVersion).toEqual(['1.0.0', '2.0.0']);
  });

  it('detects tool added', () => {
    const stored = { workflowVersion: '1.0.0' };
    const registered = { workflowVersion: '1.0.0', toolVersions: ['new-tool@1.0.0'] };
    const diff = diffTeaVersionTuples(stored, registered);
    const change = diff.toolVersions?.find((c) => c.tool === 'new-tool');
    expect(change?.change).toBe('added');
    if (change?.change === 'added') expect(change.to).toBe('1.0.0');
  });

  it('detects tool removed', () => {
    const stored = { workflowVersion: '1.0.0', toolVersions: ['old-tool@1.0.0'] };
    const registered = { workflowVersion: '1.0.0' };
    const diff = diffTeaVersionTuples(stored, registered);
    const change = diff.toolVersions?.find((c) => c.tool === 'old-tool');
    expect(change?.change).toBe('removed');
    if (change?.change === 'removed') expect(change.from).toBe('1.0.0');
  });

  it('detects tool version changed', () => {
    const stored = { workflowVersion: '1.0.0', toolVersions: ['my-tool@1.0.0'] };
    const registered = { workflowVersion: '1.0.0', toolVersions: ['my-tool@2.0.0'] };
    const diff = diffTeaVersionTuples(stored, registered);
    const change = diff.toolVersions?.find((c) => c.tool === 'my-tool');
    expect(change?.change).toBe('changed');
    if (change?.change === 'changed') {
      expect(change.from).toBe('1.0.0');
      expect(change.to).toBe('2.0.0');
    }
  });
});

// ---------------------------------------------------------------------------
// formatTeaVersionDiff
// ---------------------------------------------------------------------------

describe('formatTeaVersionDiff', () => {
  it('returns empty string for an empty diff', () => {
    expect(formatTeaVersionDiff({})).toBe('');
  });

  it('formats workflow version change', () => {
    const output = formatTeaVersionDiff({ workflowVersion: ['1.0.0', '2.0.0'] });
    expect(output).toContain('workflow version: 1.0.0 → 2.0.0');
  });

  it('formats tool added', () => {
    const output = formatTeaVersionDiff({
      toolVersions: [{ tool: 'new-tool', change: 'added', to: '1.0.0' }],
    });
    expect(output).toContain('new-tool');
    expect(output).toContain('added');
  });
});
