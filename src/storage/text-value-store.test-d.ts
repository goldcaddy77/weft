import { MemoryStorage } from './memory.ts';
import { textValueStore, type TextValueStore } from './text-value-store.ts';

/**
 * Vendored copy of Agent Bureau's `KeyValueStore` interface. Inlined so this
 * type-level test does not introduce a runtime or build-time dependency on
 * any downstream package.
 *
 * Synced from `agent-bureau/packages/storage/src/types.ts` on 2026-05-12.
 * Update this comment and the interface together whenever the upstream
 * shape changes; `documentation/integrations/agent-bureau.md` is the public
 * record of the contract.
 */
interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  has?(key: string): Promise<boolean>;
  deletePrefix?(prefix: string): Promise<number>;
  close?(): Promise<void>;
}

// A wrapped storage must satisfy the consumer-facing contract.
const _wrapped: KeyValueStore = textValueStore(new MemoryStorage());
void _wrapped;

// The exported `TextValueStore` type must structurally satisfy it.
declare const _typed: TextValueStore;
const _typeCheck: KeyValueStore = _typed;
void _typeCheck;

// Sanity check: returning the wrong value type from `get` must not satisfy
// the contract. This guards against the wrapper drifting to a binary surface.
type WrongGet = Omit<TextValueStore, 'get'> & { get(key: string): Promise<Uint8Array | null> };
declare const _wrong: WrongGet;
// @ts-expect-error — Uint8Array is not assignable to string.
const _wrongCheck: KeyValueStore = _wrong;
void _wrongCheck;
