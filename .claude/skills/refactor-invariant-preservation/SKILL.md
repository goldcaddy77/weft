---
name: refactor-invariant-preservation
description: >-
  Use this skill before refactoring Weft engine, server, storage, worker, or
  agent internals where overload ergonomics, ordering, event sequences, return
  shapes, type-level behavior, or public examples must remain unchanged.
---

# Refactor Invariant Preservation

## When to use

- Refactoring internals behind existing public APIs such as `Engine.create()`, `recoverAll()`, workflow handles, or server operations.
- Changing a multi-phase algorithm where result ordering or event sequencing is observable.
- Modifying TypeScript overloads, default generics, inference helpers, or exported type ergonomics.
- Replacing implementation structure while claiming behavior is unchanged.
- Deduplicating server operation helpers, REST fault shapers, storage helpers, client delegation, or test-support utilities while keeping endpoint contracts unchanged.
- Cleaning up API surface exports, lifecycle overloads, compression framing, visibility filters, or route helpers after review feedback.

## Do not use

- New features that intentionally define new behavior.
- Mechanical renames that cannot affect runtime order, public types, or public examples.
- Test-only cleanup where no production behavior or type surface is touched.

## Workflow

1. Write characterization tests for current public behavior before changing the implementation.
2. Pin observable ordering directly; do not hide ordering changes with sorting unless order is explicitly irrelevant.
3. Add type-level tests for overloads, deferred registration, dynamic names, and inference behavior when TypeScript ergonomics are part of the contract.
4. For REST operation cleanup, preserve the exact legacy status codes, raw or masked error messages, validation envelopes, and route matching behavior unless the task explicitly changes the contract.
5. For compression cleanup, preserve framed payload reads across gzip, brotli, and uncompressed values; never reintroduce headerless compressed payload acceptance unless a task explicitly requires a migration layer.
6. For workflow visibility cleanup, preserve `createdAt desc, id asc` ordering, aggregate truncation/cap behavior, and failure-category projection defaults.
7. Keep test-only helpers in `.test-support.ts` or equivalent test-only files and verify they do not leak into production declarations.
8. Compare documentation examples against the public API after the refactor.
9. Keep compatibility by preserving behavior, not by adding shims or old import paths unless explicitly required.

## Verification

- Add or update runtime tests for ordering, event sequence, and return shape invariants.
- Add type-level coverage when the refactor changes public TypeScript ergonomics.
- Run focused tests, `bun run typecheck`, and documentation verification when examples changed.
