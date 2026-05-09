# Roadmap

A running list of remaining issues, gaps, and follow-ups discovered while reading through the docs and code. Each item should carry enough context that we can pick it up cold later without re-doing the investigation.

This file tracks remaining work only. Completed roadmap items belong in git history and pull request records, not in the active queue.

## 1. Cross-Process Type Generation

- [ ] **Expose JSON Schema registries from the server.**

  **Where:** new endpoint `GET /v1/registry` or a JSON-RPC method. Reuse the existing definition-schema conversion path in `src/core/types/definition-schema-to-json.ts` and the server schema extraction patterns in `src/server/openapi-schemas.ts`, `src/server/openrpc.ts`, and `src/server/asyncapi.ts`.

  Return a snapshot shaped like:

  ```ts
  {
    workflows: {
      [name: string]: {
        inputSchema?: Record<string, unknown>;
        outputSchema?: Record<string, unknown>;
        description?: string;
        tags?: string[];
      };
    };
    activities: {
      [name: string]: {
        inputSchema?: Record<string, unknown>;
        outputSchema?: Record<string, unknown>;
        queue?: string;
        description?: string;
      };
    };
  }
  ```

  Gate the endpoint behind authentication and a dedicated authorization scope because schemas can leak internal data shapes. Extend remote-worker activity registration so worker-supplied activity schemas can be unioned into the registry document. Keep the response a snapshot, not a stream.

  **Acceptance criteria:**
  - The registry endpoint returns registered workflow and activity metadata with JSON Schema objects when schemas are present.
  - The endpoint rejects unauthenticated or unauthorized callers.
  - Remote-worker-registered activities can contribute schema metadata without replacing local activity metadata.
  - Snapshot tests cover deterministic ordering and missing-schema behavior.
  - Verification passes with `bun run lint`, `bun run typecheck`, targeted registry tests, and `bun run verify:documentation`.

- [ ] **Add `weft codegen` CLI.**

  **Where:** new `src/cli/codegen.ts` and `src/cli/codegen-emit.ts`. Add `codegen` to the CLI command union and dispatch path in `src/cli.ts` / `src/cli-main.ts`.

  ```bash
  bunx weft codegen --server https://weft.internal:7233 --token "$WEFT_TOKEN" --out src/weft.generated.d.ts
  ```

  The command fetches the registry, validates it against a Zod schema, and emits a single `.d.ts` with module augmentation for `WorkflowRegistry` and `ActivityTypes`. Output must be deterministic: alphabetically sorted keys, stable formatting, byte-identical output for unchanged registry responses, and idempotent writes.

  Support authentication via `--token`, `WEFT_TOKEN`, or `~/.weft/credentials`. Include `--from <path>` for offline or vendored registry JSON. Leave non-TypeScript targets out of v1, but keep the emitter structured so future targets can be added without changing the registry contract.

  **Acceptance criteria:**
  - The CLI emits valid TypeScript declaration output from a registry fixture.
  - Running the command twice with the same input does not rewrite the output file.
  - Invalid registry JSON fails with a clear diagnostic and no partial output.
  - Generated declarations typecheck in a package-root fixture.
  - Verification passes with `bun run lint`, `bun run typecheck`, `bun run typecheck:tests`, targeted CLI tests, and `bun run verify:documentation`.

## 2. MCP Server Support

Per the AI Surface Shrinkage decision, Weft does not ship an MCP client. Weft's workflow surface is a separate concern: registered workflows can be exposed as durable MCP tools and resources to external MCP clients.

- [ ] **Implement an MCP server exposing Weft as a first-class MCP service.**

  **Deployment shapes:**
  - **Remote MCP over Streamable HTTP:** add an authenticated MCP endpoint to the existing server transport surface. Support client-to-server POST, server-to-client GET/SSE, and session resumption via `Mcp-Session-Id`.
  - **Local stdio package:** publish a `weft-mcp` or `@weft/mcp` binary that can run embedded against local storage or proxy to a remote Weft server.

  **Server behavior:**
  - Handle `initialize`, `notifications/initialized`, `notifications/cancelled`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `resources/subscribe`, `resources/unsubscribe`, `resources/templates/list`, `prompts/list`, `prompts/get`, `logging/setLevel`, `ping`, and `completion/complete`.
  - Advertise `tools`, `resources`, optional `prompts`, and `logging` capabilities.
  - Expose each eligible registered workflow as an MCP tool with a JSON Schema `inputSchema`.
  - Include engine-control tools such as `start_workflow`, `signal_workflow`, `update_workflow`, `query_workflow`, `cancel_workflow`, `list_workflows`, and `get_workflow_state`.
  - Expose read-only resources for workflow state, checkpoint history, event logs, and search-attribute query results.
  - Return `tools/call` failures as `isError: true` content blocks, not JSON-RPC protocol errors.
  - Map MCP cancellation to `engine.cancel(id)` and emit progress notifications for long-running calls.

  **Rules:**
  - Tool names are lowercase with underscores.
  - Tool descriptions come from workflow registration metadata.
  - Activities are never exposed as standalone MCP tools; workflows are the durable unit.
  - Every MCP-exposed workflow must have an input schema.
  - Remote tenant scoping resolves from session authentication; local embedded mode is single-tenant; local proxy forwards the configured token.

  **Acceptance criteria:**
  - A reference MCP client can initialize, list tools, call a workflow tool, cancel an in-flight call, read a workflow resource, and subscribe to resource updates.
  - Both remote HTTP and local stdio transports have integration tests.
  - Authorization and tenant-scoping tests prove cross-tenant data is not exposed.
  - Verification passes with `bun run lint`, `bun run typecheck`, targeted MCP tests, and `bun run verify:documentation`.

- [ ] **Add MCP catalog discovery metadata.**

  **Where:** extend the OpenRPC document with an `x-weft-mcp` extension and add a `/.well-known/mcp.json` route once the live MCP server exists.

  Native MCP `tools/list` is the canonical live introspection surface. The static catalog is for build-time consumers and deployment discovery, so keep it minimal.

  **Acceptance criteria:**
  - `/.well-known/mcp.json` points clients at the correct MCP transport endpoints.
  - OpenRPC includes enough `x-weft-mcp` metadata to connect the static operation catalog to live MCP tool discovery.
  - Static metadata tests fail if MCP-enabled workflows are omitted.
  - Verification passes with `bun run lint`, `bun run typecheck`, targeted catalog tests, and `bun run verify:documentation`.

## 3. Polyglot Activity Workers

- [ ] **Finish RemoteWorker protocol hardening for non-TypeScript SDKs.**

  **Where:** `documentation/reference/remote-worker-protocol.md`, `src/worker/index.ts`, `src/server/json-rpc-websocket.ts`, and the server-side worker-stream implementation.

  The protocol reference exists. Remaining work is to make the contract executable and versioned.

  **Remaining work:**
  - Add a `protocolVersion` field to the `register` message and make the server accept an explicit supported range.
  - Add observable registration outcomes, such as `registerAck` and `registerError`, so workers can distinguish an idle queue from a rejected registration.
  - Add JSON Schema definitions for every worker-to-server and server-to-worker message.
  - Add a drift-prevention test that compares the documented protocol schema with the TypeScript message handlers.
  - Ship a conformance suite or `weft conformance` subcommand that SDK authors can run against a candidate worker.
  - Cover lifecycle, unknown-message handling, heartbeat lapse, cancellation, reconnect with in-flight work, and graceful shutdown.

  **Acceptance criteria:**
  - A non-TypeScript worker implementation can validate its outbound and inbound messages against published schemas.
  - The TypeScript `RemoteWorker` sends a protocol version and handles registration acknowledgement or rejection.
  - The server rejects unsupported protocol versions with a clear error.
  - The conformance suite can fail a deliberately broken worker fixture.
  - Verification passes with `bun run lint`, `bun run typecheck`, targeted worker protocol tests, and `bun run verify:documentation`.

## 4. Agent Bureau Compatibility

**Architectural commitment:** Agent Bureau consumes Weft, never the reverse. Weft cannot import from `armorer`, `conversationalist`, or `interoperability` in runtime source.

- [x] **Design Weft's tool-and-conversation surface as a minimal durable-execution contract Agent Bureau can compose on top of.**

  **Where:** `src/ai/types.ts` or the surviving post-shrinkage agent type home, `src/ai/agent.ts`, `src/ai/declaration.ts`, and new documentation under `documentation/integrations/agent-bureau.md`.

  Weft owns only the minimal durable-execution contract. Agent Bureau can extend that contract structurally with richer semantics.

  **Target surface:**
  - `JSONValue`: recursive JSON-safe type matching Agent Bureau's shape.
  - `ToolCall`: `{ id: string; name: string; arguments: JSONValue }`.
  - `ToolResult`: `{ callId: string; outcome: 'success' | 'error' | 'action_required'; content: JSONValue; error?; action?; inputDigest?; outputDigest? }`.
  - `ToolErrorShape`: `{ code: string; category: ToolErrorCategory; retryable: boolean; message: string; details?: JSONValue }`.
  - `ToolDefinition`: `{ name: string; description?: string; input: unknown; execute: (input, ctx?) => Promise<unknown>; verify?; identity?; version? }`.
  - `ConversationHistory`: `Message[]` for Weft's built-in provider transcript, or a structural Agent Bureau conversation history object from `conversationalist`.

  Every field name and shape must either match Agent Bureau's structural type exactly or be absent. Do not import Agent Bureau packages from runtime source. Keep any compatibility assertions in tests or development-only type fixtures.

  **Acceptance criteria:**
  - Type-level tests prove Agent Bureau-shaped tool calls, tool results, tool definitions, and conversation history values satisfy the Weft contract without translation.
  - Runtime agent execution still accepts existing Weft-local tools after the type cleanup.
  - Documentation explains that Weft is the durability layer and Agent Bureau is the agent framework layered above it.
  - Verification passes with `bun run lint`, `bun run typecheck`, `bun run typecheck:tests`, targeted agent tests, and `bun run verify:documentation`.

- [ ] **Make Weft's `Storage` interface a structural superset of Agent Bureau's `KeyValueStore`.**

  **Where:** `src/storage/interface.ts`, `src/storage/scoped-storage.ts`, `src/storage/typed-storage.ts`, built-in adapters under `src/storage/`, and `documentation/integrations/agent-bureau.md`.

  Keep `Uint8Array` as the canonical Weft storage value type. Solve string-oriented compatibility with explicit wrappers rather than changing the core interface.

  **Remaining work:**
  - Add a text-value wrapper that maps Weft `Uint8Array` storage to `get(key): Promise<string | null>` and `set(key, value): Promise<void>`.
  - Add a compatibility helper that maps Weft's async-iterable key surface to `list(prefix): Promise<string[]>`.
  - Add type-level tests showing wrapped Weft storage satisfies Agent Bureau's `KeyValueStore` shape.
  - Document the migration path from Agent Bureau storage to Weft storage without adding runtime dependencies on Agent Bureau.

  **Acceptance criteria:**
  - The wrapper round-trips UTF-8 text values across Memory, SQLite, IndexedDB, WebExtension, HTTP, and auto-resolved storage where those backends are available in tests.
  - `list(prefix)` returns stable string arrays from the existing key iteration surface.
  - Type-level compatibility tests use development-only imports and do not affect runtime package exports.
  - Verification passes with `bun run lint`, `bun run typecheck`, `bun run typecheck:tests`, targeted storage tests, and `bun run verify:documentation`.
