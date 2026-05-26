---
name: component-standards
description: Apply frontend domain conventions for Weft dashboard components, Svelte runes, reactivity patterns, and accessibility requirements.
allowed-tools:
  - mcp__svelte__list-sections
  - mcp__svelte__get-documentation
  - mcp__svelte__svelte-autofixer
  - mcp__svelte__playground-link
  - Bash
  - Read
  - Edit
  - Write
  - Grep
  - Glob
---

# Component Standards

## When to use

- Creating or modifying components under `src/dashboard/components/**`
- Creating or modifying domain fragments under `src/dashboard/fragments/**`
- Updating Svelte reactivity or state management in `src/dashboard/**/*.svelte.ts`
- Building or modifying views in `src/dashboard/views/**`
- Writing or fixing dashboard tests

## Do not use

- Pure server/engine workflows (`src/core/**`, `src/server/**`)
- Storage adapters (`src/storage/**`)
- Service worker code (`src/service-worker/**`)

## Constraints

- Follow `{baseDir}/rules/component-library.md`
- Follow `{baseDir}/rules/svelte-patterns.md`
- No Tailwind; use tokens from `styles/tokens.css`
- Variants via `data-*` attributes, not conditional utility classes
- No SvelteKit patterns — this is a plain Svelte 5 SPA

## Operation modes

### 1) Component API and variants

- Define props/types in `<script lang="ts" module>`
- Merge external classes with `cn()` from `utilities/class-names.ts`
- Use snippets for projected content (`children`, `header`, `footer`)
- Shared components must use the canonical implementation; do not fork per-view

### 2) Reactivity and state

- Prefer `$state`, `$derived`, `$bindable`, and minimal `$effect`
- WebSocket state lives in `.svelte.ts` files using runes at module level
- Re-run `mcp__svelte__svelte-autofixer` until clean

### 3) Data fetching and routing

- Use `ApiClient` from `getContext('api-client')` for HTTP requests
- Use `WebSocketClient` for real-time updates
- Navigation via `navigate()` from `router.svelte.ts`
- No SvelteKit load functions, form actions, or `$app/*` imports
- Workflow list filters must reuse the shared filter builder so list requests, aggregate counts, saved filter suggestions, and bulk-action previews send the same filter shape.
- Date-range filters use millisecond bounds from `datetime-local` controls and should keep loading/error state announced through accessible status regions.

### 4) Accessibility

- Cover keyboard interaction and ARIA expectations
- Form controls require `id` and `label`
- Use `aria-live` regions for dynamic status updates
- Touch targets minimum 44px

## Workflow

1. Inspect similar components/fragments/views for the existing pattern.
2. Apply the smallest change that fits component and Svelte rules.
3. Run autofixer and type checking for touched files.
4. Visually verify in the browser via `mcp__claude-in-chrome__*` tools.

## Verification

- `mcp__svelte__svelte-autofixer` returns clean for changed `.svelte` files.
- `bun run typecheck` passes.
- `bun run lint` passes.

## Additional references

- [Component Library Reference](references/component-library-reference.md)
