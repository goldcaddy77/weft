# Documentation Maintenance

The documentation is part of the public API. Keep it tied to executable source, package metadata, and verification scripts instead of treating it as a parallel story.

## Source of Truth

- `package.json` owns the package version, public export map, optional peer dependencies, and minimum Bun runtime.
- `src/index.ts` and subpath entrypoints own the public TypeScript surface.
- `documentation/reference/**` documents the consumer-facing API. Keep it aligned with the exported declarations and JSDoc examples.
- `documentation/guides/**`, `documentation/getting-started/**`, and `README.md` are the user-facing path. Examples here should prefer current public imports and real recovery semantics.
- `reference/**` is architecture and traceability material. Keep it link-valid, but do not force historical sketches or checklist snippets into the runnable markdown doctest set unless the file is promoted into `documentation/**`.
- `documentation/engine-split-log/**` is historical implementation record. Keep links valid and avoid editing it for current API style unless a broken claim is actively confusing readers.

## Verification

Run these before shipping documentation changes:

```bash
bun run verify:documentation
bun run verify:markdown-doctests
bun run verify:jsdoc:full
bun run validate
```

`verify:documentation` checks local Markdown links, heading anchors, Bun version claims, and GitHub workflow Bun pins against `package.json`.

`verify:markdown-doctests` typechecks runnable TypeScript fences under `documentation/**`. Use a bare `ts` or `typescript` fence only for standalone snippets that should compile. Use `ts partial` for fragments that need surrounding setup, and only add a new skip reason when the existing allowlist cannot describe the case.

## Recovery Examples

Recovery examples should say the durable contract directly:

- Use persistent storage when durability matters. `MemoryStorage` is for tests and ephemeral scripts.
- Register activities and workflows before calling `engine.recoverAll()` or `engine.resume(id)`.
- Use a stable workflow id when rerunning a script should resume an existing workflow. `engine.start()` without `options.id` creates a new workflow.
- Teach activities as named, registered units. Function references are ergonomic locally, but the durable dispatch key is the activity name, especially for remote workers.

## Maintenance Checklist

- Update README links when adding a new primary guide.
- Keep installation and contributor prerequisites in sync with `package.json`.
- Prefer public subpath imports in examples. Do not import from `src/**` in user-facing documentation.
- If a code example changes because the API changed, add or update a doctest, JSDoc example, or verification rule that would catch the same drift next time.
