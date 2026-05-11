---
name: contract-truth-writing
description: >-
  Use this skill when writing or reviewing Weft comments, JSDoc, documentation,
  README examples, test prose, or operation descriptions that describe wire
  responses, server diagnostics, masked errors, public APIs, or runtime recovery.
---

# Contract Truth Writing

## When to use

- Documenting server operations, REST bindings, JSON-RPC behavior, registry snapshots, recovery, or worker protocols.
- Writing test headers or comments that describe what a response, error, or log contains.
- Updating JSDoc for public exports or examples checked by documentation verification.
- Explaining diagnostics where wire responses intentionally mask internal details.

## Do not use

- Private inline comments that only explain a local algorithm and make no external promise.
- Copy edits that do not affect contract meaning.
- Marketing or positioning prose outside the technical contract surface.

## Workflow

1. Separate the wire contract, server-side diagnostics, logs or telemetry, and implementation details.
2. Verify the code path before promising that a response includes a name, message, stack, status, or actionable diagnostic.
3. Keep masked-error behavior explicit: say what clients see and where operators can inspect richer context.
4. Treat test prose as executable contract documentation; update it when assertions prove a narrower behavior.
5. Use public examples that match the current API and recovery model, not a friendlier shorthand that changes semantics.

## Verification

- Run `bun run verify:documentation` when documentation, JSDoc, anchors, or examples change.
- Run the focused tests for the operation or example being described.
- Inspect the rendered or asserted response shape before finalizing prose.
