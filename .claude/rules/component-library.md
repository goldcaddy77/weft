---
paths:
  - src/dashboard/components/**
  - src/dashboard/fragments/**
---

# Component Library

Before editing paths in this rule, load `$component-standards` and apply its constraints.

## Non-negotiables

- Use `cn()` from `../utilities/class-names.ts` for merging external `class` props only.
- Forward unknown attributes via `{...rest}`.
- No Tailwind. Use CSS custom properties from `styles/tokens.css` and scoped `<style>`.
- Variants via `data-*` attributes, not conditional classes.
- Boolean `data-*` attributes: always evaluate to `true`/`false`, never use ternaries or logical OR with `undefined`.
- Union types with literal `false` for data attributes: explicitly convert `false` to the string `"false"` for CSS attribute selectors.
- Use Snippets for content slots (`children`, `header`, `footer`, `actions`).
- Export types in module context (`<script lang="ts" module>`).
- Icons: inline SVG strings from `icons.ts`, displayed via `{@html icon}` with `aria-hidden="true"`.
- Icon sizing: derive icon class from component size prop (`icon-xs` for `xs`, otherwise `icon-sm`).
- Clamp props used in loops to valid ranges before iterating.

## Component organization

- **`src/dashboard/components/`**: Reusable, domain-agnostic primitives (button, card, modal, input, badge, etc.).
- **`src/dashboard/fragments/`**: Domain-specific compositions that combine primitives with Weft business logic (workflow table rows, event timelines, agent turns, etc.).
- **`src/dashboard/views/`**: Full page views selected by the router. Views compose fragments and components.

## Shared component contracts

- Shared components must have a single canonical implementation. Do not create per-view variants that diverge from the canonical API.
- When a view needs behavior not covered by the shared component, extend the component API (add a prop or snippet) rather than forking or overriding styles inline.
- Card headers, badge layouts, and control groups must use consistent spacing tokens. Do not use ad-hoc pixel values that deviate from `tokens.css` spacing scale.

## Styling

- Tokens: spacing (`--space-1` to `--space-16`), typography (`--text-xs` to `--text-lg`), colors (`--text`, `--text-muted`, `--text-subtle`, `--text-disabled`), surfaces (`--surface`, `--surface-raised`, `--surface-overlay`), semantic (`--accent`, `--success`, `--warning`, `--danger`).
- When consolidating variants into a shared base, keep typography differences in variant selectors.
- CSS Grid animations: never use the `hidden` attribute with grid-template-rows transitions; the global `[hidden] { display: none !important; }` overrides `display: grid`.
- Use `data-*` attributes and `overflow: hidden` on content to control expanded/collapsed state.
- CSS selector cleanup: do not duplicate base class in attribute selectors.

## Accessibility

- Form controls require `id` and `label` (use `hideLabel` to visually hide).
- Overlays: `role="dialog"`, `aria-modal="true"`, `aria-labelledby`/`aria-describedby`.
- Touch targets: prefer `min-height: var(--touch-target-min)` (44px).
- Never use `--text-disabled` for informational text (fails contrast).
- Use `aria-pressed` (not `aria-selected`) for `role="button"` elements.
- Use `aria-live="polite"` for progress/status, `aria-live="assertive"` for errors/alerts. Pair with `aria-atomic="true"` when the entire region should be re-read.
- Destructive actions: require explicit typed confirmation, case-insensitive comparison, disabled button until confirmed, `autocomplete="off"`.

## Keyboard navigation

- Capture state before modifying when restoring focus (save ID before setting to `null`).
- Skip container shortcuts inside text inputs (`<input>`, `<textarea>`, `contenteditable`).
- Check `defaultPrevented` for Escape key before handling at the container level.
- Use `classList.contains` (not `closest`) for exact element matching in keyboard handlers.
- Roving tabindex utilities must `preventDefault()` on all handled keys, even when index does not change.
- Navigation utilities with disabled items must stay at current index when all items are disabled.

## Context patterns

- `ApiClient` and toast store are set in `application.svelte` via `setContext`.
- Access them with `getContext('api-client')` and `getContext('toasts')` respectively.
- Use `Symbol()` context keys for new context providers.

## :global() usage

- Use for: `{@html}` content styling, third-party component children, component class props.
- Avoid for icons; use `.icon-xs`, `.icon-sm`, `.icon-md`, `.icon-lg` utility classes instead.

## Avoiding dead code

- Remove unused CSS transitions targeting properties that never change.
- Remove unused `$state` variables and handlers that do not affect rendering.
- Prefer CSS pseudo-classes (`:focus`, `:hover`, `:active`) over equivalent JavaScript state.

## Long lists

- Use `content-visibility: auto` with `contain-intrinsic-size: auto <fallback>` for long scroll lists.
