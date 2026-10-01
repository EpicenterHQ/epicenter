# Svelte Component And UI Patterns

Detailed Svelte guidance for component props, self-contained components, view branching, repetitive markup, referential stability, loading states, prop-first derivation, and template gotchas.

# Styling

For general CSS and Tailwind guidelines, see the `styling` skill.

# UI component boundary

Apps use `@epicenter/ui` subpaths. Components and extras are vendored in
`packages/ui/src`; this repo does not use shadcn-svelte's app-local
`$lib/components/ui` layout or a `components.json` in the UI package. Read the
[UI package guide](../../../../packages/ui/README.md) for imports, component
selection, Vega styling, and the update workflow. Do not run an unpinned
`shadcn-svelte add` or `jsrepo add` into the live package: generated files need
review against the local overlay, imports, and component contracts.

For a changed component's current API or composition, check its local source
and the [shadcn-svelte docs](https://shadcn-svelte.com/docs/components) or
[shadcn-svelte-extras docs](https://www.shadcn-svelte-extras.com/docs). The
[upstream shadcn-svelte skill](https://github.com/huntabyte/shadcn-svelte/tree/main/skills/shadcn-svelte)
is useful for discovery, but its CLI and alias instructions assume a standard
shadcn-svelte project.

Import Lucide icons from individual paths such as
`@lucide/svelte/icons/database`; convert touched barrel imports when local to
the change.

# DOM Attachments

For new reusable DOM behavior on elements, prefer Svelte 5 attachments:

```svelte
<input
	{@attach (node) => node.select()}
/>
```

Use `use:` actions when you are preserving existing code or consuming a library
that only exposes an action. If you need to pass an action through a component
or compose it with other DOM behavior, check `fromAction` in `svelte/attachments`
before writing adapter code yourself.

This repo already uses `{@attach (node) => node.select()}` for focused edit
fields in Matter. Follow that shape for small one-off element behavior; extract
an attachment factory only when several call sites share the behavior or the
setup owns cleanup.

# Props Pattern

## Bindable Props And Ownership

Treat props as parent-owned unless the component deliberately exposes a
two-way binding API. Svelte allows temporary prop reassignment, but mutating a
parent-owned state proxy from a child produces an ownership warning. Do not add
`$bindable` just to quiet that warning; decide whether the child is a controlled
component or whether it should ask the parent to act.

Use callback props for commands and one-shot events:

```svelte
<!-- BAD: child mutates parent-owned row state -->
<script lang="ts">
	let { row }: { row: { archived: boolean } } = $props();
</script>

<Button onclick={() => (row.archived = true)}>Archive</Button>

<!-- GOOD: parent keeps ownership of the command -->
<script lang="ts">
	let { row, onArchive }: {
		row: { id: string; archived: boolean };
		onArchive: (id: string) => void;
	} = $props();
</script>

<Button onclick={() => onArchive(row.id)}>Archive</Button>
```

Use `$bindable` for controlled component values that callers naturally bind:

```svelte
<!-- GOOD: wrapper exposes the same bindable surface as the input it wraps -->
<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { type WithElementRef } from '$lib/utils';

	type Props = WithElementRef<HTMLInputAttributes>;

	let { ref = $bindable(null), value = $bindable(), ...restProps }: Props =
		$props();
</script>

<input bind:this={ref} bind:value {...restProps} />
```

Good bindable candidates are controlled UI values and DOM handles: `value`,
`checked`, `open`, `ref`, `viewportRef`, and primitive state passed through from
Bits UI or local `@epicenter/ui` components. Avoid making rich domain objects
bindable just so a child can edit their fields. Domain actions such as archive,
delete, select, save, or rename should usually be callback props or mutations,
not two-way bound booleans.

## Inline Simple Props Types

Inline small, component-local prop shapes directly in `$props()`. A separate
`type Props = {...}` for a one-screen component usually adds a jump without
owning an invariant.

```svelte
<!-- NOISY: separate Props type for a simple local contract -->
<script lang="ts">
	type Props = {
		selectedWorkspaceId: string | undefined;
		onSelect: (id: string) => void;
	};

	let { selectedWorkspaceId, onSelect }: Props = $props();
</script>

<!-- GOOD: Inline props type -->
<script lang="ts">
	let { selectedWorkspaceId, onSelect }: {
		selectedWorkspaceId: string | undefined;
		onSelect: (id: string) => void;
	} = $props();
</script>
```

Keep or introduce a named `Props` type when it earns its name:

- The component wraps native elements and composes `svelte/elements` types, such
  as `HTMLInputAttributes` or `HTMLButtonAttributes`.
- The props encode a generic relationship that would be harder to read inline.
- The type is exported, reused, or documented as a public contract.
- The prop shape is large enough that the destructuring becomes unreadable.

```svelte
<!-- GOOD: wrapper component with a real type contract -->
<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { type WithElementRef } from '$lib/utils';

	type Props = WithElementRef<HTMLInputAttributes>;

	let { ref = $bindable(null), class: className, ...restProps }: Props =
		$props();
</script>
```

## Type Snippet Props When The Component Has A Typed Contract

Svelte turns content inside component tags into an implicit `children`
snippet, but that does not make the component's TypeScript contract
self-documenting. When you annotate `$props()`, type snippet props with
`Snippet` from `svelte`; use a tuple for snippet parameters.

```svelte
<!-- BAD: typed props, untyped snippet contract -->
<script lang="ts">
	let { children, title, row }: {
		children: unknown;
		title: string;
		row: unknown;
	} = $props();
</script>

<!-- GOOD: children and row are explicit snippet props -->
<script lang="ts" generics="Row">
	import type { Snippet } from 'svelte';

	let { children, title, row }: {
		children: Snippet;
		title: string;
		row: Snippet<[Row]>;
	} = $props();
</script>
```

If `children` is the only prop and no TypeScript contract is needed, the
short form is fine:

```svelte
<script lang="ts">
	let { children } = $props();
</script>

{@render children()}
```

Do not define a normal prop named `children` on a component that also accepts
child content. Svelte reserves that name for the implicit snippet.

# Self-Contained Component Pattern

## Prefer Component Composition Over Parent State Management

When building interactive components (especially with dialogs/modals), create self-contained components rather than managing state at the parent level.

### The Anti-Pattern (Parent State Management)

```svelte
<!-- Parent component -->
<script>
	let deletingItem = $state(null);
</script>

{#each items as item}
	<Button onclick={() => (deletingItem = item)}>Delete</Button>
{/each}

<AlertDialog open={!!deletingItem}>
	<!-- Single dialog for all items -->
</AlertDialog>
```

### The Pattern (Self-Contained Components)

```svelte
<!-- DeleteItemButton.svelte -->
<script lang="ts">
	import { createMutation } from '@tanstack/svelte-query';
	import { rpc } from '$lib/query';

	let { item }: { item: Item } = $props();
	let open = $state(false);

	const deleteItem = createMutation(() => rpc.items.delete.options);
</script>

<AlertDialog.Root bind:open>
	<AlertDialog.Trigger>
		<Button>Delete</Button>
	</AlertDialog.Trigger>
	<AlertDialog.Content>
		<Button onclick={() => deleteItem.mutate({ id: item.id })}>
			Confirm Delete
		</Button>
	</AlertDialog.Content>
</AlertDialog.Root>

<!-- Parent component -->
{#each items as item}
	<DeleteItemButton {item} />
{/each}
```

### Why This Pattern Works

- **No parent state pollution**: Parent doesn't need to track which item is being deleted
- **Better encapsulation**: All delete logic lives in one place
- **Simpler mental model**: Each row has its own delete button with its own dialog
- **No callbacks needed**: Component handles everything internally
- **Scales better**: Adding new actions doesn't complicate the parent

### When to Apply This Pattern

- Action buttons in table rows (delete, edit, etc.)
- Confirmation dialogs for list items
- Any repeating UI element that needs modal interactions
- When you find yourself passing callbacks just to update parent state

The key insight: It's perfectly fine to instantiate multiple dialogs (one per row) rather than managing a single shared dialog with complex state. Modern frameworks handle this efficiently, and the code clarity is worth it.

# View-Mode Branching Limit

If a component checks the same boolean flag (like `isRecentlyDeletedView`, `isEditing`, `isCompact`) in **3 or more template locations**, the component is likely serving two purposes and should be considered for extraction.

```svelte
<!-- SMELL: Same flag checked 3+ times -->
<script lang="ts">
	const notes = $derived(
		isRecentlyDeletedView ? deletedNotes : filteredNotes,  // branch 1
	);
</script>

{#if !isRecentlyDeletedView}  <!-- branch 2 -->
	<div>sort controls...</div>
{/if}

{#if isRecentlyDeletedView}  <!-- branch 3 -->
	No deleted notes
{:else}
	No notes yet
{/if}
```

### The Fix: Push Branching Up to the Parent

Move the view-mode decision to the parent. The child component takes the varying data as props:

```svelte
<!-- Parent: one branch point, explicit data flow -->
{#if viewState.isRecentlyDeletedView}
	<NoteList
		notes={notesState.deletedNotes}
		title="Recently Deleted"
		showControls={false}
		emptyMessage="No deleted notes"
	/>
{:else}
	<NoteList
		notes={viewState.filteredNotes}
		title={viewState.folderName}
	/>
{/if}
```

The child becomes dumb: it renders what it's told, with zero awareness of view modes. This keeps the branching in **one place** instead of scattered across the component tree.

### The Threshold

- **1-2 checks**: Acceptable: simple conditional rendering.
- **3+ checks on the same flag**: The component is likely two views in one. Consider pushing the varying data up as props.

# Data-Driven Repetitive Markup

When **3 or more sequential sibling elements** follow an identical pattern with only data varying, consider extracting the data into an array and using `{#each}` or a `{#snippet}`.

```svelte
<!-- BAD: Copy-paste x3 with only value/label changing -->
<DropdownMenu.Item onclick={() => setSortBy('dateEdited')}>
	{#if sortBy === 'dateEdited'}<CheckIcon class="mr-2 size-4" />{/if}
	Date Edited
</DropdownMenu.Item>
<DropdownMenu.Item onclick={() => setSortBy('dateCreated')}>
	{#if sortBy === 'dateCreated'}<CheckIcon class="mr-2 size-4" />{/if}
	Date Created
</DropdownMenu.Item>
<DropdownMenu.Item onclick={() => setSortBy('title')}>
	{#if sortBy === 'title'}<CheckIcon class="mr-2 size-4" />{/if}
	Title
</DropdownMenu.Item>

<!-- GOOD: Data-driven with {#each} -->
<script lang="ts">
	const sortOptions = [
		{ value: 'dateEdited' as const, label: 'Date Edited' },
		{ value: 'dateCreated' as const, label: 'Date Created' },
		{ value: 'title' as const, label: 'Title' },
	];
</script>

{#each sortOptions as option}
	<DropdownMenu.Item onclick={() => setSortBy(option.value)}>
		{#if sortBy === option.value}
			<CheckIcon class="mr-2 size-4" />
		{:else}
			<span class="mr-2 size-4"></span>
		{/if}
		{option.label}
	</DropdownMenu.Item>
{/each}
```

For more complex repeated patterns (e.g., toolbar buttons with tooltips), use `{#snippet}` to define the shared structure once:

```svelte
{#snippet toggleButton(pressed: boolean, onToggle: () => void, Icon: typeof BoldIcon, label: string)}
	<Tooltip.Root>
		<Tooltip.Trigger>
			<Toggle size="sm" {pressed} onPressedChange={onToggle}>
				<Icon class="size-4" />
			</Toggle>
		</Tooltip.Trigger>
		<Tooltip.Content>{label}</Tooltip.Content>
	</Tooltip.Root>
{/snippet}

{@render toggleButton(activeFormats.bold, () => editor?.chain().focus().toggleBold().run(), BoldIcon, 'Bold (Cmd+B)')}
{@render toggleButton(activeFormats.italic, () => editor?.chain().focus().toggleItalic().run(), ItalicIcon, 'Italic (Cmd+I)')}
```

### When NOT to Extract

- **2 or fewer** repetitions: extraction adds indirection without meaningful savings.
- **Structurally similar but semantically different**: if the elements serve different purposes and might diverge, keep them separate.

# Single-Use Functions And Aliases

Inline a single-use binding when it merely forwards a call, aliases a property, or stores a one-off class string. Keep it when it owns a complete operation, a meaningful interaction boundary, or a non-obvious decision. A named operation can return a Result to the handler that presents its outcome, even when that handler is its only caller. See [error-handling](../../error-handling/SKILL.md) for Result composition and consumption.

## Why Inline?

Single-use extracted bindings add indirection: the reader jumps between the script definition and the template to understand what happens on click/keydown/render. Inlining keeps cause and effect together at the point where the action happens.

```svelte
<!-- BAD: Extracted single-use function with no JSDoc or semantic value -->
<script>
	function handleShare() {
		share.mutate({ id });
	}

	function handleSelectItem(itemId: string) {
		goto(`/items/${itemId}`);
	}
</script>

<Button onclick={handleShare}>Share</Button>
<Item onclick={() => handleSelectItem(item.id)} />

<!-- GOOD: Inlined at the call site -->
<Button onclick={() => share.mutate({ id })}>Share</Button>
<Item onclick={() => goto(`/items/${item.id}`)} />
```

A single-use `const` class string is the same smell: scanning it inline beats chasing a name to a definition for no reuse.

```svelte
<!-- BAD: a class string referenced once, behind a name -->
<script lang="ts">
	const rowClass = 'grid gap-3 rounded-md border bg-background px-3 py-3';
</script>
<div class={rowClass}>...</div>

<!-- GOOD: the class lives where it is applied -->
<div class="grid gap-3 rounded-md border bg-background px-3 py-3">...</div>
```

Event-specific logic can remain inline when its steps are easier to understand beside the element:

```svelte
<!-- GOOD: Inlined keyboard shortcut handler -->
<svelte:window onkeydown={(e) => {
	const meta = e.metaKey || e.ctrlKey;
	if (!meta) return;
	if (e.key === 'k') {
		e.preventDefault();
		commandPaletteOpen = !commandPaletteOpen;
		return;
	}
	if (e.key === 'n') {
		e.preventDefault();
		notesState.createNote();
	}
}} />
```

## When A Name Earns Its Place

Keep a single-use binding when its name tells the reader what the action accomplishes, or when the function owns sequencing or a failure decision that the event wiring should not carry. Add a comment when the decision itself needs an explanation; a comment is not required merely to justify the function.

```svelte
<script lang="ts">
	/**
	 * Navigate the note list with arrow keys, wrapping at boundaries.
	 * Operates on the flattened display-order ID list to respect date grouping.
	 */
	function navigateWithArrowKeys(e: KeyboardEvent) {
		// 15 lines of keyboard navigation logic...
	}
</script>

<!-- The semantic name communicates intent better than inlined logic would -->
<div onkeydown={navigateWithArrowKeys} tabindex="-1">
```

A documented state-to-class map can also earn its name when it parks a non-obvious decision (why a cell rings amber, why digits right-align) that would be buried inside a `class={[...]}` array.

Inline bindings that merely forward values or calls; their indirection does not earn its place.

## Multi-Use Bindings

Bindings used **2 or more times** should always stay extracted: this rule only applies to single-use bindings.

# Referential Stability for Reactive Data Sources

## The Problem: New Array = Infinite Loop with TanStack Table

When feeding data from a reactive SvelteMap (or any signal-based store) into `createSvelteTable`, the `get data()` getter must return a **referentially stable** array. If it creates a new array on every access, TanStack Table's internal `$derived` enters an infinite loop:

```
1. $derived calls get data() -> new array (Array.from().sort())
2. TanStack Table sees "data changed" -> updates internal $state (row model)
3. $state mutation invalidates the $derived
4. $derived re-runs -> get data() -> new array again (always new!)
5. -> infinite loop -> page freeze
```

TanStack Query hid this problem because its cache returns the **same reference** until a refetch. SvelteMap getters that do `Array.from(map.values()).sort()` create a new array every call.

## The Fix: Memoize with `$derived`

In `.svelte.ts` modules, use `$derived` to compute the sorted/filtered array once per SvelteMap change:

```typescript
// Bad: new array on every access -> infinite loop with TanStack Table
get sorted(): Recording[] {
    return Array.from(map.values()).sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
}

// Good: $derived caches the result, stable reference between SvelteMap changes
const sorted = $derived(
    Array.from(map.values()).sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    ),
);

// Expose via getter (returns cached $derived value)
get sorted(): Recording[] {
    return sorted;
}
```

## When This Matters

The infinite loop only happens when the array is consumed by something that **tracks reference identity in a reactive context**:

- `createSvelteTable({ get data() { ... } })`: **DANGEROUS** (infinite loop)
- `$derived(someStore.sorted)` where the result feeds back into state: **DANGEROUS**
- `{#each someStore.sorted as item}` in a template: **SAFE** (Svelte's each block diffs by value, renders once per change)
- `$derived(someStore.get(id))`: **SAFE** (returns existing object reference from SvelteMap.get())

## Rule of Thumb

If a `.svelte.ts` state module has a computed getter that returns an array/object, and that getter could be consumed by TanStack Table or a `$derived` chain that feeds into `$state`, **always memoize with `$derived`**. The cost is near-zero (one extra signal), and it prevents a class of bugs that's invisible in development until the page freezes.

# Loading and Empty State Patterns

## Never Use Plain Text for Loading States

Always use the `Spinner` component from `@epicenter/ui/spinner` instead of plain text like "Loading...". This applies to:

- `{#await}` blocks gating on async readiness
- `{#if}` / `{:else}` conditional loading
- Button loading states

## Full-Page Loading (Async Gate)

When gating UI on an async promise (e.g. `whenReady`, `whenLoaded`), use `Empty.*` for both loading and error states. This keeps the structure symmetric:

```svelte
<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { Spinner } from '@epicenter/ui/spinner';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
</script>

{#await someState.whenReady}
	<Empty.Root class="flex-1">
		<Empty.Media>
			<Spinner class="size-5 text-muted-foreground" />
		</Empty.Media>
		<Empty.Title>Loading tabs...</Empty.Title>
	</Empty.Root>
{:then _}
	<MainContent />
{:catch}
	<Empty.Root class="flex-1">
		<Empty.Media>
			<TriangleAlertIcon class="size-8 text-muted-foreground" />
		</Empty.Media>
		<Empty.Title>Failed to load</Empty.Title>
		<Empty.Description>Something went wrong. Try reloading.</Empty.Description>
	</Empty.Root>
{/await}
```

## Inline Loading (Conditional)

When loading state is controlled by a boolean or null check:

```svelte
<script lang="ts">
	import { Spinner } from '@epicenter/ui/spinner';
</script>

{#if data}
	<Content {data} />
{:else}
	<div class="flex h-full items-center justify-center">
		<Spinner class="size-5 text-muted-foreground" />
	</div>
{/if}
```

## Button Loading State

Use `Spinner` inside the button, matching the `AuthForm` pattern:

```svelte
<Button onclick={handleAction} disabled={isPending}>
	{#if isPending}<Spinner class="size-3.5" />{:else}Submit{/if}
</Button>
```

## Empty State (No Data)

Use the `Empty.*` compound component for empty states (no results, no items):

```svelte
<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
</script>

<Empty.Root class="py-8">
	<Empty.Media>
		<FolderOpenIcon class="size-8 text-muted-foreground" />
	</Empty.Media>
	<Empty.Title>No items found</Empty.Title>
	<Empty.Description>Create an item to get started</Empty.Description>
</Empty.Root>
```

### Key Rules

- **Never** show plain text ("Loading...", "Loading tabs...") without a `Spinner`
- **Always** include `{:catch}` on `{#await}` blocks. This prevents infinite spinners on failure
- Use `{:then _}` for readiness gates when the resolved value is unused. Bare `{:then}` is valid Svelte, but Biome 2.4.x rejects it in `.svelte` files
- Use `text-muted-foreground` for loading text and spinner color
- Use `size-5` for full-page spinners, `size-3.5` for inline/button spinners
- Match the `Empty.*` compound component pattern for both error and empty states

# Prop-First Data Derivation

When a component receives a prop that already carries the information needed for a decision, derive from the prop. Never reach into global state for data the component already has.

```svelte
<!-- BAD: Reading global state for info the prop already carries -->
<script lang="ts">
	import { viewState } from '$lib/state';
	let { note }: { note: Note } = $props();

	// viewState.isRecentlyDeletedView is redundant: note.deletedAt has the answer
	const showRestoreActions = $derived(viewState.isRecentlyDeletedView);
</script>

<!-- GOOD: Derive from the prop itself -->
<script lang="ts">
	let { note }: { note: Note } = $props();

	// The note knows its own state: no global state needed
	const isDeleted = $derived(note.deletedAt !== undefined);
</script>
```

### Why This Matters

- **Self-describing**: The component works correctly regardless of which view rendered it.
- **Fewer imports**: Dropping a global state import reduces coupling.
- **Testable**: Pass a note with `deletedAt` set and the component behaves correctly: no need to mock view state.

### The Rule

If the data needed for a decision is already on a prop (directly or derivable), **always** derive from the prop. Global state is for information the component genuinely doesn't have.

# Template Gotchas

## Unicode Escapes Don't Work in HTML Context

In Svelte, `\uXXXX` escape sequences work in JavaScript strings (inside `<script>` and `{expressions}`) but are treated as **literal text** in HTML template attributes and text content.

```svelte
<!-- BAD: \u2026 renders as literal "\u2026" in the browser -->
<input placeholder="Search\u2026" />
<Tooltip.Content>Toggle terminal (\u2318`)</Tooltip.Content>
<p>Close the tab, reopen\u2014your notes are there.</p>

<!-- GOOD: write the visible text directly, using repo-approved punctuation -->
<input placeholder="Search..." />
<Tooltip.Content>Toggle terminal (Cmd+`)</Tooltip.Content>
<p>Close the tab, reopen: your notes are there.</p>
```

JavaScript contexts are fine: these are standard JS string escapes:

```svelte
<script>
  // Good: Works: JS string in <script>
  createPlaceholderPlugin('Start writing\u2026');
</script>

<!-- Good: Works: JS expression in template -->
{aiChatState.provider || 'Provider\u2026'}
{isLoading ? 'Loading\u2026' : 'Ready'}
```

Common characters affected: `\u2014` (:), `\u2026` (...), `\u2318` (Cmd), `\u21e7` (Shift), `\u2192` (->).

**Rule**: In HTML attributes and text content, do not use JavaScript escape sequences. Write the visible text directly, using ASCII substitutions where this repo's writing rules require them. Reserve `\uXXXX` for JavaScript strings only.
