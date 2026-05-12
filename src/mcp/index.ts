/**
 * MCP server support for Weft.
 *
 * This subpath is server/runtime-oriented. Browser-safe entry points remain
 * under `weft`, `weft/client`, and `weft/service-worker`.
 *
 * @module mcp
 */

export { handleMcpHttpRequest } from './http.ts';
export type { McpHttpRequestOptions } from './http.ts';
export { DEFAULT_MCP_MAX_BODY_BYTES, MCP_PROTOCOL_VERSION } from './protocol.ts';
export { McpSessionManager, createMcpSessionManager } from './session.ts';
export { runMcpStdioSession } from './stdio.ts';
export type { McpStdioAdmission, McpStdioSessionOptions, McpStdioSessionResult } from './stdio.ts';
