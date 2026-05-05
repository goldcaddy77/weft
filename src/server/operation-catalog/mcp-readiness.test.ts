import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createLiveOperationRegistry } from '../rest-bindings.ts';

describe('mcpExposable ratchet', () => {
  it('every operation has an explicit mcpExposable boolean (not undefined)', () => {
    const registry = createLiveOperationRegistry();
    for (const operation of registry.list()) {
      expect(typeof operation.mcpExposable).toBe('boolean');
    }
  });

  it('all v1 operations are mcpExposable: false', () => {
    const registry = createLiveOperationRegistry();
    for (const operation of registry.list()) {
      expect(operation.mcpExposable).toBe(false);
    }
  });

  it('operations with mcpExposable: true must have a non-trivial inputSchema', () => {
    const registry = createLiveOperationRegistry();
    for (const operation of registry.list()) {
      if (!operation.mcpExposable) continue;
      expect(operation.inputSchema).toBeInstanceOf(z.ZodObject);
      const objectSchema = operation.inputSchema as z.ZodObject & {
        readonly _def: { readonly unknownKeys?: unknown };
      };
      const shape = objectSchema.shape as Record<string, unknown>;
      const hasProperties = Object.keys(shape).length > 0;
      const unknownKeysPolicy = objectSchema._def.unknownKeys;
      expect(hasProperties || unknownKeysPolicy === 'strict').toBe(true);
    }
  });
});
