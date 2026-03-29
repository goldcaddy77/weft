import { describe, expect, it } from 'bun:test';

import { ActivityRegistry } from './activity-registry.ts';
import type { RetryPolicy } from './types.ts';
import { activity } from './types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFunction(): (...args: unknown[]) => unknown {
  return (_input: unknown) => 'result';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActivityRegistry', () => {
  describe('register() and resolve()', () => {
    it('registers a function by name and resolves it back', () => {
      const registry = new ActivityRegistry();
      const fn = makeFunction();

      registry.register('greet', fn);

      expect(registry.resolve('greet')).toBe(fn);
    });

    it('returns undefined for an unregistered name', () => {
      const registry = new ActivityRegistry();

      expect(registry.resolve('nonexistent')).toBeUndefined();
    });

    it('overwrites a previous registration for the same name', () => {
      const registry = new ActivityRegistry();
      const first = makeFunction();
      const second = makeFunction();

      registry.register('greet', first);
      registry.register('greet', second);

      expect(registry.resolve('greet')).toBe(second);
    });
  });

  describe('has()', () => {
    it('returns true for a registered name', () => {
      const registry = new ActivityRegistry();
      registry.register('greet', makeFunction());

      expect(registry.has('greet')).toBe(true);
    });

    it('returns false for an unregistered name', () => {
      const registry = new ActivityRegistry();

      expect(registry.has('unknown')).toBe(false);
    });
  });

  describe('getMetadata()', () => {
    it('returns metadata keyed to the function reference', () => {
      const registry = new ActivityRegistry();
      const fn = makeFunction();

      registry.register('greet', fn, {
        queue: 'high-priority',
        timeout: '30 seconds',
        idempotent: true,
      });

      const metadata = registry.getMetadata(fn);
      expect(metadata).toBeDefined();
      expect(metadata!.name).toBe('greet');
      expect(metadata!.queue).toBe('high-priority');
      expect(metadata!.timeout).toBe('30 seconds');
      expect(metadata!.idempotent).toBe(true);
    });

    it('stores default values when no options are provided', () => {
      const registry = new ActivityRegistry();
      const fn = makeFunction();

      registry.register('greet', fn);

      const metadata = registry.getMetadata(fn);
      expect(metadata).toBeDefined();
      expect(metadata!.name).toBe('greet');
      expect(metadata!.queue).toBe('default');
      expect(metadata!.timeout).toBeUndefined();
      expect(metadata!.idempotent).toBeUndefined();
    });

    it('returns undefined for a function that was never registered', () => {
      const registry = new ActivityRegistry();

      expect(registry.getMetadata(makeFunction())).toBeUndefined();
    });

    it('stores a custom retry policy', () => {
      const registry = new ActivityRegistry();
      const fn = makeFunction();
      const retry: RetryPolicy = {
        maxAttempts: 5,
        initialBackoff: 500,
        backoffMultiplier: 1.5,
        maxBackoff: 10_000,
      };

      registry.register('compute', fn, { retry });

      const metadata = registry.getMetadata(fn);
      expect(metadata!.retry).toEqual(retry);
    });
  });

  describe('getMetadataByName()', () => {
    it('returns metadata by activity name', () => {
      const registry = new ActivityRegistry();
      const fn = makeFunction();

      registry.register('greet', fn, { queue: 'email' });

      const metadata = registry.getMetadataByName('greet');
      expect(metadata).toBeDefined();
      expect(metadata!.name).toBe('greet');
      expect(metadata!.queue).toBe('email');
    });

    it('returns undefined for an unregistered name', () => {
      const registry = new ActivityRegistry();

      expect(registry.getMetadataByName('unknown')).toBeUndefined();
    });
  });

  describe('auto-extraction from ActivityDefinition', () => {
    it('extracts metadata from an activity() definition registered by name', () => {
      const registry = new ActivityRegistry();
      const greet = activity({
        name: 'greet',
        execute: (input: string) => `Hello, ${input}!`,
        timeout: '30 seconds',
        queue: 'high-priority',
        idempotent: true,
        retry: {
          maxAttempts: 5,
          initialBackoff: 500,
          backoffMultiplier: 1.5,
          maxBackoff: 10_000,
        },
      });

      registry.register('greet', greet);

      const metadata = registry.getMetadata(greet);
      expect(metadata).toBeDefined();
      expect(metadata!.name).toBe('greet');
      expect(metadata!.timeout).toBe('30 seconds');
      expect(metadata!.queue).toBe('high-priority');
      expect(metadata!.idempotent).toBe(true);
      expect(metadata!.retry).toEqual({
        maxAttempts: 5,
        initialBackoff: 500,
        backoffMultiplier: 1.5,
        maxBackoff: 10_000,
      });
    });

    it('auto-extracts metadata when no explicit options are passed', () => {
      const registry = new ActivityRegistry();
      const greet = activity({
        name: 'greet',
        execute: (input: string) => `Hello, ${input}!`,
        queue: 'notifications',
      });

      // Register without explicit options — should auto-extract from the definition
      registry.register('greet', greet);

      const metadata = registry.getMetadata(greet);
      expect(metadata!.queue).toBe('notifications');
    });

    it('prefers explicit options over auto-extracted metadata', () => {
      const registry = new ActivityRegistry();
      const greet = activity({
        name: 'greet',
        execute: (input: string) => `Hello, ${input}!`,
        queue: 'from-definition',
      });

      registry.register('greet', greet, { queue: 'explicit-override' });

      const metadata = registry.getMetadata(greet);
      expect(metadata!.queue).toBe('explicit-override');
    });
  });

  describe('unregister()', () => {
    it('removes a registration by name', () => {
      const registry = new ActivityRegistry();
      const fn = makeFunction();

      registry.register('greet', fn);
      registry.unregister('greet');

      expect(registry.has('greet')).toBe(false);
      expect(registry.resolve('greet')).toBeUndefined();
    });

    it('is a no-op for a name that was never registered', () => {
      const registry = new ActivityRegistry();

      // Should not throw
      registry.unregister('nonexistent');
    });
  });

  describe('names()', () => {
    it('returns all registered activity names', () => {
      const registry = new ActivityRegistry();
      registry.register('a', makeFunction());
      registry.register('b', makeFunction());
      registry.register('c', makeFunction());

      const names = [...registry.names()];
      expect(names.toSorted()).toEqual(['a', 'b', 'c']);
    });

    it('returns an empty iterator when nothing is registered', () => {
      const registry = new ActivityRegistry();

      expect([...registry.names()]).toEqual([]);
    });
  });
});
