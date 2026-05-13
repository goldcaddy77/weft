---
name: semantic-compatibility
description: >-
  Use this skill when a Weft change renames, reshapes, normalizes, hashes,
  serializes, or replays persisted data such as effect-log records, checkpoints,
  tool calls, tool results, JSONValue content, storage payloads, or compatibility
  fixtures.
---

# Semantic Compatibility

## When to use

- Renaming fields in persisted or replayed shapes, such as `input` to `arguments`.
- Changing semantic hash inputs, canonicalization, serialization, or codec behavior.
- Updating `JSONValue`, tool-call, tool-result, checkpoint, storage, or effect-log data.
- Adding compatibility with another package while Weft still owns the runtime contract.
- Generating or validating cross-process declarations from registry snapshots, or wrapping byte-oriented storage for string-oriented consumers.

## Do not use

- Purely local helper refactors with no stored, hashed, replayed, or exported shape.
- New internal types that never cross a persistence, public API, or interoperability boundary.
- Documentation-only edits unless the documentation promises persisted compatibility.

## Workflow

1. Identify every boundary that observes the shape: fresh execution, commit, replay, decode, event snapshots, public types, and compatibility fixtures.
2. Preserve semantic keys used for idempotency unless the migration explicitly changes them and includes old-record handling.
3. Add old-vs-new fixtures before changing implementation behavior when existing stored records may exist.
4. Normalize replayed values through the same path as fresh values, especially JSON-safe outputs and lossy codec values.
5. For registry codegen, pin deterministic output and make unsupported JSON Schema keywords degrade to `unknown` rather than emitting an unsound type.
6. Keep external compatibility structural and dev/test-only; do not import sibling package runtime types into Weft runtime source.

## Verification

- Add regression tests that prove old committed records still deduplicate and replay without re-executing effects.
- Test fresh execution and replay produce the same normalized content shape.
- Run the relevant focused test, then `bun run typecheck` and `bun run validate` before shipping.
