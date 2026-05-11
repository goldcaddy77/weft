---
name: roadmap-context
description: >-
  Use this skill when starting roadmap-driven Weft work or preparing to open a
  pull request for completed roadmap work, so the agent reads ROADMAP.md first
  and updates it when a body of work is complete.
---

# Roadmap Context

## When to use

- Picking up any task from `ROADMAP.md`.
- Implementing feature work that maps to an active roadmap item.
- Preparing a pull request for a completed roadmap body of work.
- Reviewing whether a roadmap item is complete, stale, or still blocked.

## Do not use

- One-off fixes with no relationship to active roadmap items.
- Documentation or test cleanup that does not complete roadmap work.
- Pull request stabilization after `ROADMAP.md` has already been updated correctly.

## Workflow

1. Read `ROADMAP.md` before editing code and identify the exact body of work being addressed.
2. Restate the relevant acceptance criteria in the implementation plan or pull request notes.
3. Keep scope to one coherent roadmap body unless the user explicitly asks for a broader sweep.
4. Before opening a pull request, update `ROADMAP.md` to remove completed active-queue items or mark completion according to the file's current convention.
5. If implementation proves the roadmap item is stale or already done, update `ROADMAP.md` with the discovered truth instead of leaving stale work queued.

## Verification

- Confirm the pull request diff includes the intended `ROADMAP.md` update when roadmap work is completed.
- Run the verification commands listed in the completed roadmap item's acceptance criteria.
- Run `bun run verify:documentation` when roadmap edits change anchors, links, or referenced documentation.
