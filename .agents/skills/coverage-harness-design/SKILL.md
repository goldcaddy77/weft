---
name: coverage-harness-design
description: >-
  Use this skill when restoring or protecting Weft coverage with LCOV-backed
  branch targeting, structural test doubles, coverage allowlists, conformance
  fixtures, or tests for hard-to-reach protocol, schema, lifecycle, and CLI paths.
---

# Coverage Harness Design

## When to use

- Restoring verified 100 percent coverage from `coverage/lcov.info` or `scripts/check-coverage.ts`.
- Covering protocol parsing, OpenAPI or AsyncAPI schema branches, conformance harness output, shutdown, or observability helpers.
- Deciding whether a coverage allowance is justified.
- Building a structural test double to reach a branch hidden by normal constructors or registries.

## Do not use

- Adding tests without a concrete uncovered branch or behavior risk.
- Hiding reachable production code with coverage ignores.
- Changing production behavior only to make instrumentation easier.

## Workflow

1. Start from fresh LCOV output and identify the exact uncovered file, line, function, or branch.
2. Decide whether the branch is reachable, dead, generated, or race-only before editing source.
3. Prefer focused regression tests that prove a real invariant, such as component-name collision suffixing or conformance error formatting.
4. Use structural test doubles when normal builders enforce invariants that prevent exercising the target branch.
5. Keep allowlist entries narrow, documented, and removable; remove stale allowances when coverage becomes real.

## Verification

- Run `WEFT_COVERAGE_MODE=1 bun test --timeout 15000 --coverage --coverage-reporter=lcov --coverage-dir=coverage`.
- Parse the generated LCOV with `scripts/check-coverage.ts` or the repository's coverage verification command.
- Run broader validation only when the coverage fix also changes production code, public APIs, or documentation.
