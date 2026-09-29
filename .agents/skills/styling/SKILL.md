---
name: styling
description: CSS and Tailwind, cn(), flex layouts. Use for "style this", "fix the CSS", "add classes", "not scrolling", "overflow", Tailwind utilities.
metadata:
  author: epicenter
  version: '1.0'
---

# Styling Guidelines

When styling depends on shadcn-svelte structure, class merging, variants, Bits UI
composition, or local wrapper behavior, read
[ui-design's component-system reference](../ui-design/references/component-system.md)
for upstream grounding. Ordinary Tailwind utilities and the repo-local layout
rules below need no external lookup.

## Minimize Wrapper Elements

Avoid creating unnecessary wrapper divs. If classes can be applied directly to an existing semantic element with the same outcome, prefer that approach.

### Good (Direct Application)

```svelte
<main class="flex-1 mx-auto max-w-7xl">
	{@render children()}
</main>
```

### Avoid (Unnecessary Wrapper)

```svelte
<main class="flex-1">
	<div class="mx-auto max-w-7xl">
		{@render children()}
	</div>
</main>
```

This principle applies to all elements where the styling doesn't conflict with the element's semantic purpose or create layout issues.

## Tailwind Best Practices

- Use `cn()` from `@epicenter/ui/utils` in apps and `../utils.js` inside the UI package for combining classes conditionally
- Prefer utility classes over custom CSS for local layout and state
- Prefer shared scale and semantic-token utilities over arbitrary bracketed values and raw colors
- Use `tailwind-variants` for component variant systems
- Follow the `background`/`foreground` convention for colors
- Leverage CSS variables for theme consistency

## Shared Primitive Overrides

When styling a local `@epicenter/ui` primitive, use `ui-design`'s component-system reference. Tailwind classes on shared primitives should usually express parent layout or product state, not redefine the primitive's visual budget.

Good primitive overrides:

```svelte
<Item.Button size="sm" class="w-full justify-start text-left" />
```

Suspicious primitive overrides:

```svelte
<Item.Button size="sm" class="gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent/50" />
```

If an override repeats size, density, radius, gap, padding, typography, hover, focus, or transition classes, ask whether the primitive needs a size, variant, or semantic wrapper instead.

## Disabled States: Use HTML `disabled` + Tailwind Variants

When an interactive element can be non-interactive (empty section, loading state, no items), use the HTML `disabled` attribute instead of JS conditional guards. Pair it with Tailwind's `enabled:` and `group-disabled:` variants.

### Why `disabled` Over JS Guards

- `disabled` natively blocks clicks: no `if (!hasItems) return` needed
- Enables the `:disabled` CSS pseudo-class for styling
- Semantically correct for accessibility (screen readers announce "dimmed" or "unavailable")
- Tailwind's `enabled:` and `group-disabled:` variants compose cleanly

### Pattern

```svelte
<!-- The button disables itself when count is 0 -->
<button
  class="group enabled:cursor-pointer enabled:hover:opacity-80"
  disabled={item.count === 0}
  onclick={toggle}
>
  {item.label} ({item.count})
  <ChevronIcon class="group-disabled:invisible" />
</button>
```

### Key Variants

- `enabled:cursor-pointer`: pointer cursor only when clickable
- `enabled:hover:bg-accent/50`: hover effects only when interactive
- `group-disabled:invisible`: hide child elements (e.g., expand chevron) when parent is disabled
- `disabled:opacity-50`: dim the element when disabled

### Anti-Pattern

```svelte
<!-- Don't do this: JS guard duplicates what disabled does natively -->
<button
  class="cursor-pointer hover:opacity-80"
  onclick={() => { if (item.count > 0) toggle(); }}
>
```

The JS guard leaves `cursor-pointer` and `hover:opacity-80` active on a non-interactive element. The user sees a clickable button that does nothing. Use `disabled` and let the browser + CSS handle it.

## Flex Column Scroll Trap

When a flex child uses `h-full` (height: 100%) but shares a flex column with siblings (headers, toolbars, footers), it computes to the *full parent height*: overflowing past siblings instead of taking the *remaining space*. The content gets clipped or pushes the layout past the viewport, and scroll areas inside never activate.

This is the single most common layout bug in this codebase. It appears whenever you have:

- A component inside a `Resizable.Pane` (paneforge) that needs to scroll
- A `ScrollArea.Root` (bits-ui) or `overflow-auto` div inside a flex column with a header/toolbar sibling
- Any split-pane or panel layout where one section should scroll independently

### The Fix: `flex-1 min-h-0 overflow-hidden`

Replace `h-full` with these three utilities on the flex child that contains scrollable content. Each solves a distinct problem:

| Utility | What it does | Why it's needed |
|---|---|---|
| `flex-1` | Take remaining space after siblings | `h-full` = 100% of parent, ignoring siblings. `flex-1` = remaining space. |
| `min-h-0` | Allow shrinking below content size | Flex items default to `min-height: auto`, preventing them from being smaller than their content. |
| `overflow-hidden` | Establish a bounded height context | Without this, children with `overflow-auto` or `ScrollArea` have no height ceiling to scroll against. |

All three are required. Missing any one breaks the fix:

- Without `flex-1`: element is still 100% of parent, overflows siblings
- Without `min-h-0`: element refuses to shrink, content pushes it taller
- Without `overflow-hidden`: inner scroll containers have no bounded ancestor, so they expand instead of scrolling

### Before / After

```svelte
<!-- BROKEN: h-full = 100% of parent, ignores the toolbar sibling -->
<main class="flex h-full flex-col overflow-hidden">
  <div class="border-b px-4 py-2">Toolbar</div>
  <MyScrollableContent class="h-full" />  <!-- overflows past main -->
</main>

<!-- FIXED: flex-1 takes remaining space, overflow-hidden bounds it -->
<main class="flex h-full flex-col overflow-hidden">
  <div class="border-b px-4 py-2">Toolbar</div>
  <MyScrollableContent class="flex-1 min-h-0 overflow-hidden" />
</main>
```

### Inside Resizable Panes (paneforge)

Paneforge `Pane` components set width via flex ratios but do not constrain height or clip overflow. Any scrollable content inside a Pane needs the full `flex-1 min-h-0 overflow-hidden` chain on its root element:

```svelte
<Resizable.Pane defaultSize={80}>
  <!-- Pane provides no height constraint or overflow clipping -->
  <div class="flex flex-1 min-h-0 flex-col overflow-hidden">
    <div class="border-b">Header</div>
    <div class="flex-1 overflow-y-auto">
      <!-- this content now scrolls -->
    </div>
  </div>
</Resizable.Pane>
```

### With ScrollArea (bits-ui)

`ScrollArea.Root` renders with `position: relative` and its viewport uses `height: 100%`. This breaks the flex sizing chain: the viewport's percentage height resolves against the `relative` parent, which has no explicit height in a flex context. The content expands instead of scrolling.

Two options:

1. **Prefer plain `overflow-y-auto`** on a div with `flex-1 min-h-0` (simpler, always works)
2. **If you need styled scrollbars**, wrap `ScrollArea.Root` in a div with `flex-1 min-h-0 overflow-hidden` to give it a bounded ancestor

```svelte
<!-- Option 1: Plain overflow (preferred) -->
<div class="flex-1 overflow-y-auto">
  {#each items as item}
    <div>{item.name}</div>
  {/each}
</div>

<!-- Option 2: ScrollArea with bounded wrapper -->
<div class="flex-1 min-h-0 overflow-hidden">
  <ScrollArea.Root class="h-full">
    {#each items as item}
      <div>{item.name}</div>
    {/each}
  </ScrollArea.Root>
</div>
```

### Rule of Thumb

If you write `h-full` on a flex child that has siblings in the same flex column, **stop and replace it with `flex-1 min-h-0 overflow-hidden`**. The `h-full` pattern only works when the element is the sole child of its flex parent.
