---
name: security-review
description: Security review checklist for weft covering server routes, MCP authentication, workflow trust boundaries, storage, activity isolation, and credential handling.
---

# Security Review

Checklist for reviewing security-sensitive changes in the weft durable execution engine. Focus on trust boundaries — where user input, external data, or untrusted workflow code meets the engine.

## When to Activate

- Adding or modifying server routes (`src/server/handler.ts`)
- Changing MCP authentication or credential handling (`src/ai/mcp/`)
- Modifying workflow execution, checkpoint replay, or activity dispatch (`src/core/`)
- Changing storage backends or serialization (`src/storage/`, `src/core/codec.ts`)
- Adding new public API surface (`src/index.ts`)
- Handling environment variables or secrets (`src/environment.ts`)

## Checklist

### 1. Server Route Validation

**File**: `src/server/handler.ts`

The server exposes 12 REST routes via `handleRequest(request, engine)`. For each route that accepts input:

- [ ] Path parameters are decoded safely (`decodeURIComponent` is already used — verify no double-decoding)
- [ ] Request bodies are parsed with try/catch (malformed JSON returns 400, not 500)
- [ ] Query parameters (`status`, `type`, `limit`, `offset`) are validated before use — check for NaN on numeric params, validate enum values against allowed sets
- [ ] No user-controlled strings are interpolated into storage keys without sanitization
- [ ] Error messages do not leak internal state (stack traces, storage keys, file paths)

Routes that accept bodies: `POST /v1/workflows`, `POST /v1/workflows/{id}/signal/{name}`, `POST /v1/workflows/{id}/update/{name}`, `PATCH /v1/workflows/{id}/attributes`

### 2. MCP Authentication

**Files**: `src/ai/mcp/authentication.ts`, `src/ai/mcp/client.ts`

- [ ] Bearer tokens and API keys from `MCPAuthConfig` are never logged, serialized to checkpoints, or included in error messages
- [ ] `buildAuthHeaders()` does not leak credentials through header names in error paths
- [ ] Token values are not stored in workflow state that gets persisted to storage
- [ ] If MCP connections fail, retry logic does not log the auth headers

### 3. Workflow Trust Boundary

**Files**: `src/core/engine.ts`, `src/core/context.ts`, `src/core/checkpoint.ts`

User-defined workflow functions run inside the engine. They should not be able to:

- [ ] Access engine internals or other workflows' state
- [ ] Corrupt checkpoint data (verify checkpoint writes are atomic)
- [ ] Inject arbitrary data that gets `eval()`'d or `new Function()`'d on replay
- [ ] Cause unbounded memory growth through oversized checkpoint payloads
- [ ] Escape the workflow context to access the underlying storage directly

### 4. Storage and Serialization

**Files**: `src/storage/bun-sql.ts`, `src/storage/memory.ts`, `src/core/codec.ts`

- [ ] `BunSQLiteStorage` uses parameterized queries — no string concatenation for SQL
- [ ] The `encode()`/`decode()` codec (msgpack) does not execute code during deserialization
- [ ] Storage keys constructed from user input (workflow IDs, attribute names) are bounded in length and character set
- [ ] Batch operations in storage cannot be used to overwrite keys belonging to other workflows
- [ ] IndexedDB storage (`src/storage/indexeddb.ts`) applies the same key validation

### 5. Activity Isolation

**Files**: `src/workers/activity-runner.ts`, `src/core/activities.ts`

- [ ] Activity timeouts are enforced — a hung activity cannot block the engine indefinitely
- [ ] Activity results are bounded in size before being written to checkpoints
- [ ] Failed activities do not leak internal engine state in their error messages
- [ ] Worker pool exhaustion is handled gracefully (backpressure, not crash)

### 6. Input Validation at API Boundaries

- [ ] Public-facing functions validate inputs with Zod or explicit type guards (following the `src/environment.ts` pattern)
- [ ] No `any` types at trust boundaries: server routes, storage interface methods, public API exports
- [ ] Duration strings passed to `parseDuration()` are validated (reject nonsensical values like negative durations)
- [ ] Workflow IDs and signal/update names are validated for length and character set

### 7. Credential and Secret Handling

**File**: `src/environment.ts`

- [ ] Environment variables accessed via `Bun.env` and validated through Zod schemas
- [ ] Secrets are not included in: log output, error messages, checkpoint data, HTTP responses, metrics
- [ ] `.env` files are in `.gitignore`
- [ ] No hardcoded credentials, tokens, or API keys in source code

## How to Use This Checklist

For a focused review, check only the sections relevant to the changed files. For a comprehensive audit, work through all seven sections. Mark items as verified and note any findings that need follow-up.
