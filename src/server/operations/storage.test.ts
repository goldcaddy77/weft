import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { principalFromApiKey } from '../principal.ts';

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decode(value: Uint8Array | null): string | null {
  return value === null ? null : new TextDecoder().decode(value);
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

function tenantStorageOptions() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({
        subject: 'tenant-caller',
        tenantId: 'acme',
        scopes: ['storage:read', 'storage:write'],
      }),
    },
  };
}

function writeOnlyTenantStorageOptions() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({
        subject: 'write-only-tenant-caller',
        tenantId: 'acme',
        scopes: ['storage:write'],
      }),
    },
  };
}

function adminStorageOptions() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({
        subject: 'admin-caller',
        scopes: ['storage:read', 'storage:write', 'storage:admin'],
      }),
    },
  };
}

describe('storage REST operations', () => {
  it('reads and writes bytes through tenant-scoped storage', async () => {
    const rawStorage = new MemoryStorage();
    const engine = new Engine({ storage: rawStorage });

    const putResponse = await handleRequest(
      request('/v1/storage/workflow-key', { method: 'PUT', body: encode('tenant value') }),
      engine,
      tenantStorageOptions(),
    );
    expect(putResponse.status).toBe(204);

    expect(await rawStorage.get('workflow-key')).toBeNull();
    expect(decode(await rawStorage.get('tenant:acme:workflow-key'))).toBe('tenant value');

    const getResponse = await handleRequest(
      request('/v1/storage/workflow-key', { method: 'GET' }),
      engine,
      tenantStorageOptions(),
    );
    expect(getResponse.status).toBe(200);
    expect(decode(new Uint8Array(await getResponse.arrayBuffer()))).toBe('tenant value');
  });

  it('requires storage admin scope for unscoped access', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const response = await handleRequest(
      request('/v1/storage/workflow-key', { method: 'GET' }),
      engine,
      {
        authContext: {
          method: 'api-key' as const,
          principal: principalFromApiKey({
            subject: 'unscoped-caller',
            scopes: ['storage:read'],
          }),
        },
      },
    );

    expect(response.status).toBe(403);
  });

  it('streams tenant-scoped scan results as NDJSON', async () => {
    const rawStorage = new MemoryStorage();
    await rawStorage.put('tenant:acme:wf:a', encode('a'));
    await rawStorage.put('tenant:acme:wf:b', encode('b'));
    await rawStorage.put('tenant:other:wf:c', encode('c'));
    const engine = new Engine({ storage: rawStorage });

    const response = await handleRequest(
      request('/v1/storage?prefix=wf:', { method: 'GET' }),
      engine,
      tenantStorageOptions(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/x-ndjson');
    const body = await response.text();
    const lines = body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { key: 'wf:a', value: btoa('a') },
      { key: 'wf:b', value: btoa('b') },
    ]);
  });

  it('applies tenant-scoped batch writes and deletes without touching raw keys', async () => {
    const rawStorage = new MemoryStorage();
    await rawStorage.put('tenant:acme:wf:delete', encode('old'));
    await rawStorage.put('wf:delete', encode('raw'));
    const engine = new Engine({ storage: rawStorage });

    const response = await handleRequest(
      request('/v1/storage/batch', {
        method: 'POST',
        body: JSON.stringify({
          operations: [
            { type: 'put', key: 'wf:new', value: btoa('new') },
            { type: 'delete', key: 'wf:delete' },
          ],
        }),
        headers: { 'content-type': 'application/json' },
      }),
      engine,
      tenantStorageOptions(),
    );

    expect(response.status).toBe(204);
    expect(decode(await rawStorage.get('tenant:acme:wf:new'))).toBe('new');
    expect(await rawStorage.get('tenant:acme:wf:delete')).toBeNull();
    expect(decode(await rawStorage.get('wf:delete'))).toBe('raw');
  });

  it('evaluates tenant-scoped conditional batch conditions against tenant keys only', async () => {
    const rawStorage = new MemoryStorage();
    await rawStorage.put('wf:key', encode('raw'));
    await rawStorage.put('tenant:other:wf:key', encode('other'));
    const engine = new Engine({ storage: rawStorage });

    const response = await handleRequest(
      request('/v1/storage/conditional-batch', {
        method: 'POST',
        body: JSON.stringify({
          conditions: [{ key: 'wf:key', expectedValue: null }],
          operations: [{ type: 'put', key: 'wf:key', value: btoa('tenant') }],
        }),
        headers: { 'content-type': 'application/json' },
      }),
      engine,
      tenantStorageOptions(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: true });
    expect(decode(await rawStorage.get('tenant:acme:wf:key'))).toBe('tenant');
    expect(decode(await rawStorage.get('tenant:other:wf:key'))).toBe('other');
    expect(decode(await rawStorage.get('wf:key'))).toBe('raw');
  });

  it('denies conditional batches for write-only callers because conditions reveal stored values', async () => {
    const rawStorage = new MemoryStorage();
    await rawStorage.put('tenant:acme:wf:key', encode('existing'));
    const engine = new Engine({ storage: rawStorage });

    const response = await handleRequest(
      request('/v1/storage/conditional-batch', {
        method: 'POST',
        body: JSON.stringify({
          conditions: [{ key: 'wf:key', expectedValue: btoa('existing') }],
          operations: [{ type: 'put', key: 'wf:key', value: btoa('changed') }],
        }),
        headers: { 'content-type': 'application/json' },
      }),
      engine,
      writeOnlyTenantStorageOptions(),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error:
        'Storage conditional batch requires storage:admin or both storage:read and storage:write.',
    });
    expect(decode(await rawStorage.get('tenant:acme:wf:key'))).toBe('existing');
  });

  it('applies conditional batches atomically through the server route', async () => {
    const rawStorage = new MemoryStorage();
    await rawStorage.put('key', encode('old'));
    const engine = new Engine({ storage: rawStorage });

    const response = await handleRequest(
      request('/v1/storage/conditional-batch', {
        method: 'POST',
        body: JSON.stringify({
          conditions: [{ key: 'key', expectedValue: btoa('old') }],
          operations: [{ type: 'put', key: 'key', value: btoa('new') }],
        }),
        headers: { 'content-type': 'application/json' },
      }),
      engine,
      adminStorageOptions(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: true });
    expect(decode(await rawStorage.get('key'))).toBe('new');
  });

  it('allows empty byte values in batch conditions and operations', async () => {
    const rawStorage = new MemoryStorage();
    await rawStorage.put('empty', new Uint8Array());
    const engine = new Engine({ storage: rawStorage });

    const response = await handleRequest(
      request('/v1/storage/conditional-batch', {
        method: 'POST',
        body: JSON.stringify({
          conditions: [{ key: 'empty', expectedValue: '' }],
          operations: [{ type: 'put', key: 'empty', value: '' }],
        }),
        headers: { 'content-type': 'application/json' },
      }),
      engine,
      adminStorageOptions(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: true });
    expect(await rawStorage.get('empty')).toEqual(new Uint8Array());
  });

  it('returns 400 when batch operation values are not valid base64', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });

    const response = await handleRequest(
      request('/v1/storage/batch', {
        method: 'POST',
        body: JSON.stringify({
          operations: [{ type: 'put', key: 'key', value: 'not-base64' }],
        }),
        headers: { 'content-type': 'application/json' },
      }),
      engine,
      adminStorageOptions(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Storage batch operation value must be base64.',
    });
  });

  it('returns 400 when conditional batch expected values are not valid base64', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });

    const response = await handleRequest(
      request('/v1/storage/conditional-batch', {
        method: 'POST',
        body: JSON.stringify({
          conditions: [{ key: 'key', expectedValue: 'not-base64' }],
          operations: [{ type: 'delete', key: 'key' }],
        }),
        headers: { 'content-type': 'application/json' },
      }),
      engine,
      adminStorageOptions(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Storage conditional batch expectedValue must be base64.',
    });
  });
});
