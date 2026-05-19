import { expect } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import {
  createOperationRegistry,
  executeOperation,
  type OperationRegistry,
  type RegistrableOperation,
} from '../operation-catalog.ts';
import { principalFromApiKey, principalFromJwtClaims } from '../principal.ts';

/** Disposable engine backed by `MemoryStorage` for operation tests. */
export function createOperationTestEngine(): Engine {
  return new Engine({ storage: new MemoryStorage() });
}

/** Spread into `handleRequest` options to authenticate as an api-key caller with `system:read`. */
export function systemReadAuthContext(): {
  authContext: {
    method: 'api-key';
    principal: ReturnType<typeof principalFromApiKey>;
  };
} {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({ subject: 'test', scopes: ['system:read'] }),
    },
  };
}

type AuthorizationAssertionOptions = {
  /** Operation name surfaced via the wired-up registry. */
  operationName: string;
  /** Engine owned by the suite; helper neither creates nor disposes it. */
  engine: Engine;
  /** Live registry the suite has wired against its own collaborators. */
  liveRegistry: OperationRegistry;
};

/**
 * Asserts the operation rejects an unauthenticated JSON-RPC caller with the
 * `Unauthorized` fault code. Assertion-only — the suite owns the engine and
 * registry lifecycle.
 */
export async function assertOperationRejectsUnauthenticated(
  options: AuthorizationAssertionOptions,
): Promise<void> {
  const result = await executeOperation(
    options.operationName,
    {},
    {
      principal: { method: 'unauthenticated' },
      engine: options.engine,
      transport: 'jsonRpcStdio',
      registry: options.liveRegistry,
    },
  );

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected rejection');
  expect(result.fault.code).toBe('Unauthorized');
}

/**
 * Asserts the operation rejects an authenticated caller whose principal lacks
 * the required scope. The caller is built from a JWT carrying `workflows:read`,
 * which is unrelated to the `system:read` scope these operations require, so a
 * future scope change would surface here rather than passing accidentally.
 */
export async function assertOperationRejectsInsufficientScope(
  options: AuthorizationAssertionOptions,
): Promise<void> {
  const result = await executeOperation(
    options.operationName,
    {},
    {
      principal: principalFromJwtClaims({ sub: 'user', scope: 'workflows:read' }),
      engine: options.engine,
      transport: 'jsonRpcStdio',
      registry: options.liveRegistry,
    },
  );

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected rejection');
  expect(result.fault.code).toBe('Forbidden');
}

/**
 * Asserts the raw operation (registered without its live-registry factory)
 * throws `EngineFailure` rather than silently returning stale data. Confirms
 * the discovery-only registry path is fail-loud.
 */
export async function assertOperationRequiresFactoryRegistry(options: {
  operationName: string;
  /** Raw operation export, e.g. `listWorkersOperation` (not the factory-built one). */
  rawOperation: RegistrableOperation;
  engine: Engine;
}): Promise<void> {
  const result = await executeOperation(
    options.operationName,
    {},
    {
      principal: principalFromApiKey({ subject: 'test', scopes: ['system:read'] }),
      engine: options.engine,
      transport: 'jsonRpcStdio',
      registry: createOperationRegistry([options.rawOperation]),
    },
  );

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected rejection');
  expect(result.fault.code).toBe('EngineFailure');
}
