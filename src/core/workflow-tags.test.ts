import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../storage/memory.ts';
import { Context } from './context.ts';
import { Engine } from './engine.ts';
import {
  coerceStartWorkflowTags,
  MAX_WORKFLOW_TAG_BYTES,
  MAX_WORKFLOW_TAGS,
} from './start-workflow-validation.ts';
import type { WorkflowContext } from './types.ts';

async function* echoWorkflow(_ctx: WorkflowContext, input: unknown) {
  return input;
}

async function* waitForSignalWorkflow(ctx: WorkflowContext, input: unknown) {
  const signal = yield* (ctx as Context).waitForSignal<string>('continue');
  return `${String(input)}:${signal}`;
}

describe('workflow tags', () => {
  it('tag validation rejects too many tags and oversized tags', () => {
    expect(() =>
      coerceStartWorkflowTags(
        Array.from({ length: MAX_WORKFLOW_TAGS + 1 }, (_, index) => `tag-${index}`),
        'Field "tags"',
      ),
    ).toThrow(`Field "tags" must contain at most ${MAX_WORKFLOW_TAGS} tags`);

    expect(() =>
      coerceStartWorkflowTags(['x'.repeat(MAX_WORKFLOW_TAG_BYTES + 1)], 'Field "tags"'),
    ).toThrow(`Field "tags" tags must be at most ${MAX_WORKFLOW_TAG_BYTES} UTF-8 bytes each`);
  });

  it('StartOptions.tags accepts string[] and stores normalized tags alongside workflow state', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engine.register('echo', echoWorkflow);

    try {
      const handle = await engine.start('echo', 'hello', {
        id: 'tagged-start',
        tags: ['nightly', 'v2', 'nightly'],
      });
      await handle.result();

      const state = await engine.get('tagged-start');
      expect(state).not.toBeNull();
      expect(state?.tags).toEqual(['nightly', 'v2']);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('handle.addTags(...tags) and handle.removeTags(...tags) mutate tags durably', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    engine.register('wait-for-signal', waitForSignalWorkflow);

    try {
      const handle = await engine.start('wait-for-signal', 'payload', {
        id: 'durable-tags',
        tags: ['alpha'],
      });
      await Bun.sleep(10);

      await handle.addTags('beta', 'alpha');
      await handle.removeTags('alpha');

      const state = await engine.get('durable-tags');
      expect(state?.tags).toEqual(['beta']);
    } finally {
      await engine[Symbol.asyncDispose]();
    }

    const recoveredEngine = new Engine({ storage });
    recoveredEngine.register('wait-for-signal', waitForSignalWorkflow);

    try {
      const recoveredState = await recoveredEngine.get('durable-tags');
      expect(recoveredState?.tags).toEqual(['beta']);
    } finally {
      await recoveredEngine[Symbol.asyncDispose]();
    }
  });

  it('handle.addTags(...tags) enforces the total tag count after combining with existing tags', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engine.register('wait-for-signal', waitForSignalWorkflow);

    try {
      const handle = await engine.start('wait-for-signal', 'payload', {
        id: 'tag-limit-after-add',
        tags: Array.from({ length: MAX_WORKFLOW_TAGS - 1 }, (_, index) => `tag-${index}`),
      });
      await Bun.sleep(10);

      await expect(handle.addTags('overflow-a', 'overflow-b')).rejects.toThrow(
        `Workflow tags must contain at most ${MAX_WORKFLOW_TAGS} tags`,
      );

      const state = await engine.get('tag-limit-after-add');
      expect(state?.tags).toHaveLength(MAX_WORKFLOW_TAGS - 1);
      expect(state?.tags).not.toContain('overflow-a');
      expect(state?.tags).not.toContain('overflow-b');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('handle.addTags(...tags) reports tag mutation validation errors with workflow-tag context', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engine.register('wait-for-signal', waitForSignalWorkflow);

    try {
      const handle = await engine.start('wait-for-signal', 'payload', {
        id: 'tag-validation-context',
        tags: ['alpha'],
      });
      await Bun.sleep(10);

      await expect(handle.addTags('')).rejects.toThrow(
        'Workflow tags must not contain empty tags',
      );
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it("engine.list({ tags: ['nightly', 'v2'] }) filters by tag intersection", async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engine.register('echo', echoWorkflow);

    try {
      const firstHandle = await engine.start('echo', 'one', {
        id: 'wf-1',
        tags: ['nightly', 'v2'],
      });
      const secondHandle = await engine.start('echo', 'two', { id: 'wf-2', tags: ['nightly'] });
      const thirdHandle = await engine.start('echo', 'three', { id: 'wf-3', tags: ['v2'] });
      await firstHandle.result();
      await secondHandle.result();
      await thirdHandle.result();

      const result = await engine.list({ tags: [' nightly ', 'v2', 'nightly'] });

      expect(result.total).toBe(1);
      expect(result.items.map((item) => item.id)).toEqual(['wf-1']);
      expect(result.items[0]?.tags).toEqual(['nightly', 'v2']);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('Tags are distinct from search attributes', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engine.register('searchable', {
      handler: waitForSignalWorkflow,
      searchAttributes: {
        priority: { type: 'string' },
      },
    });

    try {
      await engine.start('searchable', 'payload', {
        id: 'tag-distinction',
        tags: ['nightly'],
        searchAttributes: { priority: 'high' },
      });
      await Bun.sleep(10);

      const attributes = await engine.getAttributes('tag-distinction');
      expect(attributes).toEqual({ priority: 'high' });

      const byTags = await engine.list({ tags: ['nightly'] });
      expect(byTags.items.map((item) => item.id)).toEqual(['tag-distinction']);

      const byAttributes = await engine.list({
        attributes: [{ key: 'tags', value: 'nightly' }],
      });
      expect(byAttributes.total).toBe(0);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });
});
