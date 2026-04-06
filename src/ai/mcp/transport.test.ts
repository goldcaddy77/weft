import { describe, expect, it } from 'bun:test';

import { MCPTransportError, inferTransportKind, parseStdioUrl } from './transport';

// ---------------------------------------------------------------------------
// inferTransportKind
// ---------------------------------------------------------------------------

describe('inferTransportKind', () => {
  it('returns "stdio" for stdio:// URLs', () => {
    expect(inferTransportKind('stdio:///usr/local/bin/mcp-fs')).toBe('stdio');
  });

  it('returns "http" for http:// URLs', () => {
    expect(inferTransportKind('http://localhost:3000/mcp')).toBe('http');
  });

  it('returns "http" for https:// URLs', () => {
    expect(inferTransportKind('https://tools.example.com/mcp')).toBe('http');
  });

  it('respects explicit override to "sse"', () => {
    expect(inferTransportKind('https://tools.example.com/mcp', 'sse')).toBe('sse');
  });

  it('respects explicit override to "stdio"', () => {
    expect(inferTransportKind('https://tools.example.com/mcp', 'stdio')).toBe('stdio');
  });

  it('respects explicit override to "http"', () => {
    expect(inferTransportKind('stdio:///usr/local/bin/mcp-fs', 'http')).toBe('http');
  });
});

// ---------------------------------------------------------------------------
// parseStdioUrl
// ---------------------------------------------------------------------------

describe('parseStdioUrl', () => {
  it('extracts command path from stdio URL', () => {
    const result = parseStdioUrl('stdio:///usr/local/bin/mcp-filesystem');
    expect(result.command).toBe('/usr/local/bin/mcp-filesystem');
    expect(result.args).toEqual([]);
  });

  it('converts search params to --key value args', () => {
    const result = parseStdioUrl('stdio:///usr/local/bin/mcp-fs?root=/home/user&verbose=true');
    expect(result.command).toBe('/usr/local/bin/mcp-fs');
    expect(result.args).toEqual(['--root', '/home/user', '--verbose', 'true']);
  });

  it('throws MCPTransportError for non-stdio URLs', () => {
    expect(() => parseStdioUrl('https://example.com')).toThrow(MCPTransportError);
  });

  it('throws MCPTransportError for missing command path', () => {
    expect(() => parseStdioUrl('stdio://')).toThrow(MCPTransportError);
  });

  it('handles single search param', () => {
    const result = parseStdioUrl('stdio:///bin/tool?mode=read');
    expect(result.args).toEqual(['--mode', 'read']);
  });
});
