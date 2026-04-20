import { describe, expect, it } from 'bun:test';

import { collectWorkflowTags, toggleWorkflowTagSelection } from './workflow-tags.ts';

describe('workflow tag utilities', () => {
  it('Tags visible in dashboard workflow list as badges and filterable via tag chips', () => {
    const available = collectWorkflowTags([
      {
        id: 'wf-1',
        type: 'alpha',
        status: 'completed',
        version: '1',
        createdAt: 1,
        updatedAt: 2,
        tags: ['nightly', 'v2'],
      },
      {
        id: 'wf-2',
        type: 'beta',
        status: 'running',
        version: '1',
        createdAt: 3,
        updatedAt: 4,
        tags: ['nightly', 'critical'],
      },
    ]);

    expect(available).toEqual(['critical', 'nightly', 'v2']);
    expect(toggleWorkflowTagSelection([], 'nightly')).toEqual(['nightly']);
    expect(toggleWorkflowTagSelection(['nightly'], 'nightly')).toEqual([]);
    expect(toggleWorkflowTagSelection(['nightly'], 'v2')).toEqual(['nightly', 'v2']);
  });
});
