import { describe, expect, it } from 'bun:test';

import { KEYS, type BatchOperation, type ScanOptions, type Storage } from '../storage/interface.ts';
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

async function collectKeys(storage: Storage, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  const iterable = storage.keys
    ? storage.keys(prefix)
    : (async function* (): AsyncIterable<string> {
        for await (const [key] of storage.scan(prefix)) {
          yield key;
        }
      })();

  for await (const key of iterable) {
    keys.push(key);
  }

  return keys;
}

class WorkflowStateWriteTrackingStorage implements Storage {
  readonly #storage = new MemoryStorage();
  readonly #trackedWorkflowKey: string;

  activeWorkflowWrites = 0;
  maxConcurrentWorkflowWrites = 0;

  constructor(workflowId: string) {
    this.#trackedWorkflowKey = KEYS.workflow(workflowId);
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.#storage.get(key);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    if (key === this.#trackedWorkflowKey) {
      await this.#trackWorkflowStateWrite(() => this.#storage.put(key, value));
      return;
    }

    await this.#storage.put(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.#storage.delete(key);
  }

  scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]> {
    return this.#storage.scan(prefix, options);
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    const writesTrackedWorkflowState = operations.some(
      (operation) => operation.type === 'put' && operation.key === this.#trackedWorkflowKey,
    );
    if (writesTrackedWorkflowState) {
      await this.#trackWorkflowStateWrite(() => this.#storage.batch(operations));
      return;
    }

    await this.#storage.batch(operations);
  }

  async has(key: string): Promise<boolean> {
    return (await this.#storage.get(key)) !== null;
  }

  async deletePrefix(prefix: string): Promise<number> {
    const operations: BatchOperation[] = [];
    for await (const key of this.keys(prefix)) {
      operations.push({ type: 'delete', key });
    }
    if (operations.length === 0) {
      return 0;
    }
    await this.batch(operations);
    return operations.length;
  }

  async *keys(prefix: string, options?: ScanOptions): AsyncIterable<string> {
    for await (const [key] of this.#storage.scan(prefix, options)) {
      yield key;
    }
  }

  async count(prefix: string): Promise<number> {
    let total = 0;
    for await (const _key of this.keys(prefix)) {
      total++;
    }
    return total;
  }

  scoped(prefix: string): Storage {
    return this.#storage.scoped?.(prefix) ?? this.#storage;
  }

  [Symbol.dispose](): void {
    this.#storage[Symbol.dispose]();
  }

  async #trackWorkflowStateWrite(writeOperation: () => Promise<void>): Promise<void> {
    this.activeWorkflowWrites++;
    this.maxConcurrentWorkflowWrites = Math.max(
      this.maxConcurrentWorkflowWrites,
      this.activeWorkflowWrites,
    );

    try {
      await Bun.sleep(25);
      await writeOperation();
    } finally {
      this.activeWorkflowWrites--;
    }
  }
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

  it('handle.addTags(...tags) keeps the terminal workflow index synchronized', async () => {
    let now = 1_000;
    const storage = new MemoryStorage();
    const engine = new Engine({
      storage,
      getNow: () => now,
    });
    engine.register('echo', echoWorkflow);

    try {
      const handle = await engine.start('echo', 'done', {
        id: 'terminal-tagged-workflow',
        tags: ['alpha'],
      });
      await handle.result();

      expect(await collectKeys(storage, KEYS.terminalWorkflowPrefix())).toEqual([
        KEYS.terminalWorkflow(now, handle.id),
      ]);

      now = 2_000;
      await handle.addTags('beta');

      const state = await engine.get(handle.id);
      expect(state?.tags).toEqual(['alpha', 'beta']);
      expect(state?.updatedAt).toBe(now);
      expect(await collectKeys(storage, KEYS.terminalWorkflowPrefix())).toEqual([
        KEYS.terminalWorkflow(now, handle.id),
      ]);
    } finally {
      await engine[Symbol.asyncDispose]();
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

  it('serializes tag mutations with concurrent workflow state writes', async () => {
    const workflowId = 'serialized-tag-mutations';
    const storage = new WorkflowStateWriteTrackingStorage(workflowId);
    const engine = new Engine({ storage });
    engine.register('wait-for-signal', waitForSignalWorkflow);

    try {
      const handle = await engine.start('wait-for-signal', 'payload', {
        id: workflowId,
        tags: ['alpha'],
      });
      await Bun.sleep(10);

      const addTagsPromise = handle.addTags('beta');
      await Bun.sleep(0);
      const signalPromise = handle.signal('continue', 'done');

      await Promise.all([addTagsPromise, signalPromise]);
      await expect(handle.result()).resolves.toBe('payload:done');

      const state = await engine.get(workflowId);
      expect(state?.status).toBe('completed');
      expect(state?.tags).toEqual(['alpha', 'beta']);
      expect(storage.maxConcurrentWorkflowWrites).toBe(1);
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
