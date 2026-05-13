# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Ground Rules

**Fix problems. Do not report them.** If you encounter pre-existing warnings, lint errors, type errors, failing tests, or any other issue in the codebase — fix it. Do not ask whether to fix it. Do not explain that it's pre-existing. Do not suggest workarounds like skipping hooks. Just fix it and move on.

## Pull Request Titles

Pull request titles must use this format:

- Optional Linear prefix when applicable: `ABC-123: `
- Then a concise sentence-case action title
- No branch slug prefix
- No Markdown or inline code formatting
- No conventional-commit prefixes like `feat:` or `fix:`
- No multi-sentence acceptance-criteria dump

Before opening a PR, compute and validate the final title:

```bash
draft_title="<descriptive title>"
normalized_title=$(bun run scripts/pr-title.ts normalize --title "$draft_title" | jq -r '.normalizedTitle // empty')
pr_title="${normalized_title:-$draft_title}"
bun run scripts/pr-title.ts validate --title "$pr_title"
```

After creating the PR, read the title back from GitHub and fail immediately if it does not match:

```bash
gh pr create --title "$pr_title" --body-file /tmp/pr-body.md
created_title=$(gh pr view --json title --jq '.title')
test "$created_title" = "$pr_title"
```

## Essential Commands

### Development

```bash
bun run dev               # Start development with watch mode
bun run build             # Build for production (outputs to dist/)
# Run production build
bun ./dist/index.js       # After build, run with Bun
```

### Testing

```bash
bun test                  # Run all tests
bun test src/utils        # Run tests in specific directory
bun test logger          # Run tests matching pattern
bun test --watch         # Watch mode
bun test --coverage      # Generate coverage report
```

### Code Quality

```bash
bun run lint             # Check linting errors
bun run lint:fix         # Auto-fix linting errors
bun run typecheck        # TypeScript type checking
bun run format           # Format all files with Prettier
bun run format:check     # Check formatting without changes
```

### Utilities

```bash
bun run clean            # Clean build artifacts (dist/, coverage/, caches)
bun run verify:documentation
bun run verify:markdown-doctests
bun run verify:jsdoc:doctests
bun run verify:jsdoc:full
weft conformance -- <worker-command>
weft codegen --server http://localhost:7233 --out ./src/weft.generated.d.ts
```

`verify:documentation` is the minimum gate for public Markdown, generated reference links, and documentation anchors. Run `verify:markdown-doctests` when Markdown examples change, `verify:jsdoc:doctests` when JSDoc examples change, and `verify:jsdoc:full` before shipping changes that alter exported declarations.

Use `weft conformance` when a change touches the `RemoteWorker` protocol or worker SDK compatibility. Use `weft codegen` when validating cross-process type-generation docs or client fixtures; the command reads `/v1/registry` from a live server or `--from` a vendored registry JSON file and writes a deterministic `.d.ts`.

## Architecture Overview

### Core Design Principles

1. **Environment-First Configuration**: All configuration starts with environment variables validated through Zod schemas in `src/environment.ts`. The `environment` object is the single source of truth.

2. **Lean Surface Area**: This template intentionally avoids framework-specific scaffolding (custom error classes, logger wrappers, etc.). Add only what you need for your project.

### Key Notes

- **ESM + TypeScript**: Source files are TypeScript modules; build output targets Bun.
- **Import paths**: Use standard TS/ESM imports; no special runtime helpers are required.

### Git Hooks Architecture

Hooks live as Bun TypeScript files under `scripts/husky/` and are invoked by tiny sh wrappers in `.husky/`:

- `pre-commit`: runs lint-staged and basic dependency checks
- `post-checkout`: installs deps when `package.json`+`bun.lock` change; surfaces config changes
- `post-merge`: installs/cleans when dependencies or config changed; shows merge stats

They use `chalk` for color, `change-case` for headings, and Bun’s `$` and `Bun.write` for shell/IO.

### Types

There is no shared `src/types.ts` in this template. Add shared or domain-specific types near their modules as needed.

## TypeScript Conventions

### `any` Is Forbidden Outside Test Files

Do not use `any` in production code. Use proper types, generics, `unknown` with type narrowing, or Zod schemas. Test files (`.test.ts`, `.spec.ts`) are exempt — Oxlint relaxes this rule there.

### Type Assertions (`as`) Are Suspect

Treat every `as` cast with suspicion. The pattern `as unknown as SomeType` is a red flag that almost always means a type design problem — do not use it unless you can explain exactly why there is no better alternative.

**Prefer type guards over assertions:**

```typescript
// Preferred: Zod schema validation
const parsed = MySchema.parse(untrustedInput);

// Preferred: type guard function
function isWorkflowState(value: unknown): value is WorkflowState {
  return typeof value === 'object' && value !== null && 'status' in value;
}

// Preferred: narrowing with typeof / in / instanceof
if (typeof value === 'string') {
  /* value is string here */
}

// Acceptable when justified: simple assertion on trusted data
const state = decode(bytes) as WorkflowState; // bytes came from our own storage
```

If an `as` cast is genuinely necessary (e.g., deserializing from storage where the type is known by construction), add a brief comment explaining why. If it cannot be justified, refactor the types instead.

## Development Patterns

### Adding New Features

1. **Environment variables**: Add to `.env.example` first, then update the schema in `src/environment.ts`.
2. **Types**: Shared/reusable types go in `src/types.ts`; domain-specific types live near their modules.

### Server and Dashboard Surfaces

- New REST or JSON-RPC operations must declare their access scope, operation name, transport availability, input source mapping, and fault shaping explicitly.
- Operator diagnostics should keep metrics low-cardinality. Use bounded diagnostic endpoints for workflow IDs, operation IDs, worker IDs, queue names, and other high-cardinality evidence.
- If a server operation is surfaced in the dashboard, update the dashboard API client types and tests together with the route or operation.
- Preserve legacy REST response contracts during cleanup refactors. Shared helpers are fine, but tests must pin any intentionally raw or masked error shape.

### Testing Approach

- Tests use Bun's built-in test runner with `describe`, `it`, `expect`.
- Test files are typically colocated with sources using the `.test.ts` suffix.
- Oxlint rules are relaxed for test files (`*.test.ts`, `*.spec.ts`, `test/**`, `__tests__/**`). You can use `any`, non-null assertions, unused variables, and other patterns that would normally be flagged.
- A separate `tsconfig.test.json` is available with relaxed TypeScript settings for tests.

### Import Organization

Prettier plus import sorting keeps imports consistent. A common order is:

1. Bun built-ins (e.g., `import { file, write } from 'bun'`)
2. Node built-ins (e.g., `import { readFile } from 'node:fs'`)
3. External packages (e.g., `import { z } from 'zod'`)
4. Internal absolute imports (e.g., `@/configuration/environment`)
5. Relative imports (e.g., `./local-module`)

## Bun-Specific Considerations

- Always use `bun` commands, not `npm` or `yarn`.
- The lockfile in this repo is `bun.lock`.
- Bun provides native TypeScript execution without precompilation.
- Use `bunx` for one-off package execution (like `npx`).

### Prefer Bun Built-ins Over Node

When possible, use Bun's native APIs instead of Node.js equivalents. Bun's APIs are optimized for performance and often have a simpler interface.

| Task          | Use (Bun)                                | Avoid (Node)                     |
| ------------- | ---------------------------------------- | -------------------------------- |
| Read file     | `Bun.file(path).text()`                  | `fs.readFileSync(path, 'utf-8')` |
| Write file    | `Bun.write(path, data)`                  | `fs.writeFileSync(path, data)`   |
| HTTP server   | `Bun.serve()`                            | `http.createServer()` or Express |
| Hashing       | `Bun.hash()` or `new Bun.CryptoHasher()` | `crypto.createHash()`            |
| Spawn process | `Bun.spawn()` or `Bun.$`                 | `child_process.spawn()`          |
| Sleep         | `Bun.sleep(ms)`                          | `setTimeout` with promisify      |
| Environment   | `Bun.env.VAR`                            | `process.env.VAR`                |
| Glob          | `Bun.Glob`                               | `glob` package                   |

When a Bun equivalent doesn't exist or Node's API is more appropriate for the use case, use the `node:` prefix for clarity (e.g., `import { join } from 'node:path'`).

### Configuration Notes

- **bunfig.toml**: Build targets Bun with sourcemaps and minification.
- **TypeScript**: Uses Bun types; Node type libs are not included by default.
- **Oxlint**: Rust-based linter with built-in TypeScript, promise, unicorn, and import plugins. Type-aware rules enabled via `--type-aware --tsconfig ./tsconfig.json`. Import sorting and unused import removal handled by Prettier via `prettier-plugin-organize-imports`. Test files have relaxed rules.
- **Testing**: You can run tests in parallel via `bun test --parallel`.
