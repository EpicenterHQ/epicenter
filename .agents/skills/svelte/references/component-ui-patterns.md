# Svelte Component And UI Patterns

Detailed Svelte guidance for component props, self-contained components, view branching, repetitive markup, referential stability, loading states, prop-first derivation, and template gotchas.

# Styling

For general CSS and Tailwind guidelines, see the `styling` skill.

# UI component boundary

Monorepo apps use `@epicenter/ui` subpaths. Components and extras are vendored in
`packages/ui/src`; the UI package has no `components.json`. Personal apps in an
Epicenter own their copied `$lib/components/ui` source and theme; follow
[epicenter-app](../../epicenter-app/SKILL.md) for that layout. Read the
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

Keep small one-off element behavior beside the element. Extract an attachment
when it names meaningful setup or cleanup, shares a rule, or provides function
identity that its consumer observes. See [function identity](#when-a-name-earns-its-place).

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

## Render optional unions presence first

When several branches render variants of an optional discriminated union,
separate presence from variant selection. Use an outer
[`{#if}`](https://svelte.dev/docs/svelte/if) for presence, then read the
discriminant directly inside. Keep the owner visible instead of introducing a
`$derived` alias solely to shorten these immediate reads.

For illustration, a job's optional `progress` can distinguish queued, running,
and failed work:

```svelte
{#if job.progress}
	{#if job.progress.status === 'failed'}
		<p>Failed: {job.progress.error.message}</p>
	{:else if job.progress.status === 'running'}
		<p><Spinner class="size-3.5" /> Running...</p>
	{:else}
		<p>Queued</p>
	{/if}
{:else}
	<p>Idle</p>
{/if}
```

This makes absence one explicit branch instead of repeating
`job.progress?.status` in every condition. Optional chaining is still useful
for an isolated optional read. A local still earns its place when a deferred
callback needs narrowing or an operation must retain the exact value shown;
see the binding guidance below.

## Function bindings for transformed values

For a controlled input wrapper, expose a `$bindable` value and use Svelte's
[`bind:value={get, set}`](https://svelte.dev/docs/svelte/bind#Function-bindings)
when the caller must transform reads or writes. Paired `read`/`write` or
`getValue`/`setValue` props and forwarding value-change props recreate that
protocol. Trace their callers, transformations, and lifecycle guards before
replacing them when they only control the same value. Keep commands as callback
props and preserve real draft ownership.

```svelte
<script lang="ts">
  let code = $state('');
</script>

<input bind:value={() => code, (value) => code = value.toUpperCase()} />
<output>{code}</output>
```

### Template locals: narrow reactive values before use

A callback can run after the check that created it. TypeScript may therefore
lose narrowing for a repeated optional property access inside the binding
getter. This occurs with ordinary properties as well as JavaScript getters.
In that case, capture the optional value with `{@const}` in the nearest
template block containing the controls that need it, then narrow that local
before creating the callbacks:

```svelte
{#each items as item (item.id)}
	{@const details = item.details}
	{#if details}
		<Input bind:value={() => details.title, (title) => item.update({ title })} />
		<Textarea bind:value={() => details.notes, (notes) => item.update({ notes })} />
	{/if}
{/each}
```

`{@const}` stays reactive within its template block. Use `$derived(item.details)`
when script code also needs the value or no existing template scope supports
`{@const}` before the guard; a plain script `const details = item.details`
captures only the initial value. Narrow absent or invalid values outside the
control instead of putting `?.` and an empty fallback into every binding.
Use the source's actual sentinel (`undefined` or `null`).

Share one local across the controls that use it instead of creating one per
input. If only one control needs it, place the declaration beside that control
in its enclosing block. `{@const}` must be an immediate child of a supported
template block or component, not an arbitrary HTML element.
For a control at the component root or directly inside ordinary HTML, capture
the value with a script `$derived`, then narrow that local in the template.
Do not add an artificial loop, key, or conditional just to host `{@const}`;
those blocks introduce structure or lifetimes unrelated to the binding.

For optional text, gate the control on presence and bind to the narrowed value.
An empty string is valid content. Use `?? ''` only when absence really means an
empty editable value; it must not turn unread, missing, or non-text content into
an editable blank control.

Do not add this local mechanically. If an `{#each}` variable or a value already
held in a `const` is narrowed for the callback, use it directly. A simple
display can also read the property directly when its guard suffices. The local
earns its place by preserving narrowing or sharing a useful computation, not
by the mere presence of a getter or `bind:value`. Nested access alone, such as
`() => editor.settings.title`, needs no alias when the accessed values are
always available.

Other useful locals can name a computed predicate, share an expensive
projection, filter unchanged results for downstream consumers, or hold a dynamic
component such as `{@const Icon = item.icon}`. Inspect consumers before inlining.

### Transformations and codecs

The setter sends the change to its owner's update operation; it does not mutate
a rendered snapshot or send the whole record back. If a command composes a
replacement from existing content, read the current owner synchronously at the
event so it preserves changes made since rendering. Retain a snapshot across
`await` only when that particular operation requires it and checks whether it
still applies.

When the transformation has substantial format rules, keep its read and
write-back operations together in the format's codec or module. Give the write
operation the current source when it must preserve unrelated spans, newline
style, or other source information. A projection and a source-preserving update
are not necessarily total inverses. Show the problem when a structured edit
cannot represent what was typed. Do not turn those rules into binding
infrastructure or remove draft, identity, eligibility, or destroyed-control
guards just because the syntax becomes shorter. Tests establish whether the
operations reverse each other and which source information survives.

## File editor views

Use [the input patterns](input-ownership.md) for the choice between immediate
editing and explicit submission.

Files opens full text; a product list opens structured controls. An invalid file
shows its reason and opens as text; repairing text does not switch a
mounted editor's interpretation. Do not add per-record Source/Fields tabs, raw
mode, or automatic Source fallback.

Use the [contract editor lifecycle](lifecycle-and-reactivity.md#contract-reads-and-editing)
for collection reads, editor construction, field bindings, and saves. Key details
by the acquired editor identity.

Tabs may select actual workspaces or workflows. Shared `Tabs.Content` owns panel
mounting, so do not repeat `tab === value` inside each panel. A disabled trigger
does not establish valid fields for a later event. Use forceMount only for a
named retained lifetime.

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

# Dialog ownership

Put the dialog and its operation with the owner whose lifetime covers the
choice, submitted input, and outcome. A row can own its dialog when all of
those belong to that row's mounted lifetime. A parent can own one dialog for
a selected item, a bulk action, or a choice shared across rows.

If a pending write can remove or filter out the row, keep work that must
survive above that row. Its local dialog and per-call mutation callbacks
unmount with it. Capture the submitted item and reviewed values when the
person confirms; let the mutation owner retain essential completion work.
See [callback lifetime](../../query-layer/SKILL.md).

Use callbacks when a child asks another owner to act. Keep the operation local
when the child owns its whole lifetime. Neither a callback nor a shared dialog
is, by itself, evidence of misplaced state.

# View-mode boundaries

Repeated mode checks can reveal separate responsibilities. Follow the data,
actions, and lifetimes before splitting a component. Extract when the branches
represent independent workflows or ownership; keep local conditions when they
express one coherent interaction.

Passing varying data or snippets can make a shared view clearer. Compare the
complete callers: moving checks into parents while adding many configuration
props may only relocate the branching. The number of checks does not determine
the component boundary.

# Data-Driven Repetitive Markup

Use an array and `{#each}` when repeated controls are instances of the same
rule and only their data varies. Use a snippet when sharing markup makes that
rule clearer. Keep cheap local repetition or different interactions inline;
the number of siblings alone does not justify extraction.

```svelte
<!-- Before: the same sorting rule repeated for each option. -->
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

<!-- After: the options share one sorting rule. -->
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

- **Cheap local repetition**: Keep markup inline when a snippet adds navigation without explaining the structure or avoiding substantial repetition.
- **Structurally similar but semantically different**: if the elements serve different purposes and might diverge, keep them separate.

# Single-Use Functions And Aliases

Keep source reads and actions visible beside their controls. Inline a handler,
forwarder, property alias, or one-off class string when its name adds navigation
without explaining a rule. Judge what disappears, not the number of functions.

## Why Inline?

A guard or several statements do not require a separate handler. Keep the
permitted action beside the control when that makes it easier to understand:

```svelte
<!-- Before: the name only forwards an already clear action. -->
<script lang="ts">
  function handleShare() {
    if (!canShare) return;
    share.mutate({ id });
  }
</script>
<Button onclick={handleShare}>Share</Button>

<!-- After: the guard and request owner are visible at the control. -->
<Button onclick={() => {
  if (!canShare) return;
  share.mutate({ id });
}}>Share</Button>
```

Keep per-interaction `.mutate(...)` callbacks at that call site too. Preserve
method receivers: use `() => owner.act()` rather than passing `owner.act` when
the method needs `this`. Remove unused query entries and imports when their
actual callers have disappeared; keep the underlying service if it still has
consumers.

## When A Name Earns Its Place

Keep names for typed parsing or codecs, persistence and its failure handling,
shared rules, substantial streaming or recovery sequences, and operations whose
names explain a non-obvious decision. A page-wide keyboard map can earn its name;
a textarea shortcut that only forwards to `send()` usually fits at the textarea.
A named operation can return a Result to the handler that presents its outcome;
see [error handling](../../error-handling/SKILL.md).

Retain locals that preserve type narrowing for deferred bindings, capture one
operation's identity, or supply contextual typing a generic factory needs.
Inlining a typed intermediate can change inference even when the runtime value
looks identical. Check its callers and typecheck the resulting expression.

Keep a stable function when its consumer uses identity to control setup,
cleanup, or subscription lifetime. Svelte's
[`{@attach}`](https://svelte.dev/docs/svelte/@attach) observes the supplied
function and reactive reads made during setup. A stable conditional such as
`{@attach message.id === focus ? center : undefined}` can keep an attachment
in place across refreshed message objects. An inline attachment is also valid;
inspect its dependencies before assuming it changes identity or reruns. Naming
a function does not stop reactive reads inside it from triggering setup again.

## Preserve read timing

Inlining preserves when information is read as well as what is called:

- Preserve a `tick()` boundary when it orders DOM work after pending updates.
  Moving a scroll into an attachment establishes access to the element, but
  another caller, such as a router, may still schedule a competing scroll.
  [`tick()`](https://svelte.dev/docs/svelte/lifecycle-hooks#tick) waits for pending
  Svelte updates; it does not guarantee precedence over arbitrary async work.
  Trace both callers and verify cold and cached navigation before changing
  their scheduling.

- Read current selection or membership at the event. A template local such
  as `picked` describes the last render; several events can arrive before the
  next render. Keep the membership test inside the handler:

  ```svelte
  onclick={() => {
    chosen = chosen.includes(word.word)
      ? chosen.filter((other) => other !== word.word)
      : [...chosen, word.word];
  }}
  ```

- Preserve the [submitted operation](../../query-layer/SKILL.md)
  when inlining: move capture with the event, not into a deferred callback.
  Keep any pre-update scroll position at the phase it describes.
- When the request settles, derive updates from the current shared
  collection. When removing a deferred helper, put its replacement inside the
  callback that called it. Computing it before the request would overwrite work
  from other requests that settled in between:

  ```ts
  const graded = word;
  review.mutateAsync({ path: graded.path, grade }).then(
    (saved) => {
      const remaining = again.filter((other) => other.path !== graded.path);
      again = grade === 'again' ? [...remaining, { ...graded, ...saved }] : remaining;
    },
    reportFailure,
  );
  ```

Keep callbacks with their existing lifetime owner while moving a handler. See
[callback lifetime and timing](../../query-layer/SKILL.md)
for observer callbacks, per-execution promises, and awaited completion work.

## Multi-Use Bindings

Reuse is evidence, not an exemption from the inlining test. A forwarding
`set(changes)` wrapper can give way to direct `save.mutate({ path, ... })` calls
when it only repeats those arguments. Keep extraction when it centralizes a
shared rule, avoids substantial repetition, caches a necessary result, or makes
non-obvious work understandable. Use the same test for forwarding `$derived`
aliases; keep template locals needed to narrow optional values. See
[refactoring methods](../../collapse-pass/references/refactoring-methods.md#keep-source-and-action-visible)
and [template narrowing](#template-locals-narrow-reactive-values-before-use).

# Referential stability for reactive data sources

Use `$derived` for a reactive projection when caching its computation or
preserving its reference matters to a consumer. A table adapter, keyed setup,
or attachment may observe identity; inspect that consumer before changing how
values are constructed. A fresh array alone does not establish a feedback loop.
Trace the read, write, and invalidation that would make it repeat.

An ordinary `{#each}` does not require a memoized array merely to render it.
When row identity must survive reordering or replacement, use an appropriate
each key. Keep existing upstream getters when required by their API; new read
APIs can return the derived value through a method.

# Loading, empty, and error states

Render the state its owner actually exposes. Missing data alone does not tell
you whether a read is pending, failed, or successfully empty. Read the query,
mutation, editor, or readiness promise that owns that distinction.

- For a stable readiness promise, use `{#await}`. Add `{:catch}` when this block
  owns a possible rejection and its presentation. It may be omitted when no
  rejection is possible or failure already has an explicit owner. Omitting
  `{:catch}` does not create error handling.
- For an operation that exposes pending and error state, read those states
  directly. Preserve meaningful button labels while indicating progress and
  blocking duplicate actions where required.
- Show an empty state after a successful empty answer. Choose error content
  according to what failed and what the person can do next; it need not share
  the empty state's markup.

Use the app's established loading and empty components where they fit. Follow
[ui-design](../../ui-design/SKILL.md) for presentation and
[readiness gates](lifecycle-and-reactivity.md#async-gate-variant) for promise
ownership. Spinner choice and layout do not change who owns request state.

# Derive from the owner of the fact

Use a prop when it already carries the fact needed for a decision. If restore
eligibility depends on whether a note is deleted, derive it from the note's
saved deletion state rather than inferring it from which list is open.

View mode is a different fact: it can decide layout, available controls, or
empty-state text even when two views contain the same note. Read it from its
owner or pass the relevant choice explicitly. Verify that two values mean the
same thing before replacing one with the other; a shorter dependency list is
not evidence that the information is equivalent.

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
