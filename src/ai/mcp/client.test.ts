import { describe, expect, it } from 'bun:test';

import { MCPClient, MCPServerUnavailableError, MCPToolTimeoutError } from './client';

describe('MCPClient', () => {
  it('stores constructor options', () => {
    const client = new MCPClient({
      serverUrl: 'https://mcp.example.com',
      auth: { type: 'bearer', token: 'test-token' },
      timeout: 5000,
    });

    // The client should be constructable without errors
    expect(client).toBeInstanceOf(MCPClient);
  });

  it('returns false from healthCheck when the URL is invalid', async () => {
    const client = new MCPClient({
      serverUrl: 'http://localhost:1',
      timeout: 1000,
    });

    const healthy = await client.healthCheck();
    expect(healthy).toBe(false);
  });
});

describe('MCPServerUnavailableError', () => {
  it('stores serverUrl', () => {
    const error = new MCPServerUnavailableError('https://mcp.example.com');

    expect(error).toBeInstanceOf(Error);
    expect(error.serverUrl).toBe('https://mcp.example.com');
    expect(error.message).toContain('https://mcp.example.com');
  });

  it('stores the underlying cause', () => {
    const cause = new Error('connection refused');
    const error = new MCPServerUnavailableError('https://mcp.example.com', cause);

    expect(error.cause).toBe(cause);
  });
});

describe('MCPToolTimeoutError', () => {
  it('stores toolName and timeout', () => {
    const error = new MCPToolTimeoutError('slow-tool', 30000);

    expect(error).toBeInstanceOf(Error);
    expect(error.toolName).toBe('slow-tool');
    expect(error.timeout).toBe(30000);
    expect(error.message).toContain('slow-tool');
    expect(error.message).toContain('30000');
  });
});
