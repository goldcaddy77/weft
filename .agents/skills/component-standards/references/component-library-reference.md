# Component Library Reference

Code examples and patterns for the Weft dashboard component library.

## Component anatomy

```svelte
<script lang="ts" module>
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
  export type ButtonProps = Omit<HTMLAttributes<HTMLButtonElement>, 'class'> & {
    class?: string;
    variant?: ButtonVariant;
    children?: Snippet;
  };
</script>

<script lang="ts">
  import { cn } from '../utilities/class-names.ts';
  let { variant = 'secondary', class: className, children, ...rest }: ButtonProps = $props();
</script>

<button class={cn('button', className)} data-variant={variant} {...rest}>
  {@render children?.()}
</button>
```

## Union types with literal `false` for data attributes

When a prop type includes `false` as a literal and is used in a CSS attribute selector, explicitly convert the value to a string:

```typescript
type Animation = 'shimmer' | 'pulse' | false;
let { animation = 'shimmer' }: { animation?: Animation } = $props();
const animationAttr = $derived(animation === false ? 'false' : animation);
// Use in template: data-animation={animationAttr}
```

## Icon sizing from component size prop

```typescript
const iconClass = $derived(size === 'xs' ? 'icon-xs' : 'icon-sm');
```

Icons in this project are inline SVG strings from `icons.ts`, rendered with `{@html icon}` and wrapped in a span with `aria-hidden="true"`.

## Clamping props used in loops

```typescript
// WRONG: Directly uses boundaries in loop, crashes when boundaries > totalPages
for (let i = 1; i <= boundaries; i++) pages.push(i);

// CORRECT: Clamp to valid range before loops
const effectiveBoundaries = Math.min(boundaries, Math.floor(totalPages / 2));
const firstEnd = Math.min(effectiveBoundaries, totalPages);
```

## Styling tokens

| Category   | Tokens                                                       |
| ---------- | ------------------------------------------------------------ |
| Spacing    | `--space-1` to `--space-16`                                  |
| Typography | `--text-xs`, `--text-sm`, `--text-base`, `--text-lg`         |
| Colors     | `--text`, `--text-muted`, `--text-subtle`, `--text-disabled` |
| Surfaces   | `--surface`, `--surface-raised`, `--surface-overlay`         |
| Semantic   | `--accent`, `--success`, `--warning`, `--danger`             |

## CSS Grid animations

Never use the `hidden` attribute with grid-template-rows transitions:

```css
.panel {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--duration) var(--ease-decelerate);
}

.item[data-expanded='true'] .panel {
  grid-template-rows: 1fr;
}

.content {
  overflow: hidden;
}
```

## Accessibility

### ARIA live regions

| Attribute               | When to use                                  |
| ----------------------- | -------------------------------------------- |
| `aria-live="polite"`    | Progress updates, status changes, non-urgent |
| `aria-live="assertive"` | Errors, alerts, urgent notifications         |

Always pair with `aria-atomic="true"` when the entire region should be re-read on change.

### Destructive action confirmation

```svelte
<script lang="ts">
  let confirmationInput = $state('');
  const expectedPhrase = $derived(`delete ${workflowName}`);
  const isConfirmed = $derived(
    confirmationInput.toLowerCase() === expectedPhrase.toLowerCase()
  );
</script>

<label for="confirm-delete">
  Type <code>{expectedPhrase}</code> to confirm
</label>
<input id="confirm-delete" type="text" bind:value={confirmationInput} autocomplete="off" />
<button disabled={!isConfirmed}>Permanently Delete</button>
```

## Keyboard navigation

### Skip container shortcuts inside text inputs

```typescript
const isTextInput =
  target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
if (event.altKey && event.key === 'ArrowDown' && !isTextInput) {
  /* ... */
}
```

### Check `defaultPrevented` for Escape key

```typescript
if (event.key === 'Escape' && !event.defaultPrevented) {
  event.preventDefault();
  event.stopPropagation();
  onCancel?.();
}
```

### Roving tabindex: always prevent default on handled keys

```typescript
const newIndex = handleRovingKeydown(event, currentIndex, items.length);
if (newIndex !== null) {
  event.preventDefault();
  if (newIndex !== currentIndex) {
    selectItem(newIndex);
  }
}
```

## Context patterns

```typescript
// In application.svelte
const apiClient = new ApiClient();
setContext('api-client', apiClient);

// In any component
const apiClient = getContext<ApiClient>('api-client');
```

## Routing

```typescript
// Navigate programmatically
import { navigate } from '../router.svelte.ts';

function handleClick(event: MouseEvent): void {
  event.preventDefault();
  navigate('/ui/workflows');
}
```

## :global() usage

Use `:global()` for:

1. `{@html}` content styling (e.g., inline SVG icons)
2. Component class props (style parent-scoped class passed to child root)

```css
.card-icon :global(svg) {
  width: 1rem;
  height: 1rem;
}
```

## CSS selector cleanup

```css
/* WRONG: Duplicated .link class */
.link[data-variant='default'].link[data-active='true'] {
}

/* CORRECT: Single .link class with chained attribute selectors */
.link[data-variant='default'][data-active='true'] {
}
```
