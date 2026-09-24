# Svelte Mutations And Workspace Inputs

Detailed Svelte guidance for TanStack Query mutation placement, inline template actions, and commit-on-blur workspace field editing.

# Mutation Patterns

## Core Rule

In `.svelte` files, use `createMutation` for user-triggered async operations when the template observes operation lifecycle state: disabled controls, loading text, spinners, or mutation-managed success and error state. Presenting one final Result as a toast alone does not require a mutation.

`createMutation` is the component operation lifecycle primitive. It is not reserved for cache invalidation, retry policy, or shared mutation keys.

Use `defineMutation` in `$lib/queries` when the operation has shared query-layer identity: multiple consumers, cache invalidation, optimistic updates, or `useIsMutating`. For a one-off Result-returning component action whose lifecycle the template observes, keep the operation as a plain function in `$lib/operations`, `$lib/services`, or a focused module, then wrap it locally with `createMutation(() => resultMutationOptions({ mutationKey, mutationFn }))`.

Use direct `await` when no template lifecycle state is observed, when the code runs outside component context, or when a sequential workflow would become harder to read as mutation callbacks. Shared Wellcrafted mutations are callable, so imperative query mutation usage is `await queries.thing(input)`.

## Async Button Pattern

Pass `onSuccess` and `onError` as the second argument to `.mutate()` so the callback stays next to the UI action that needs it:

```svelte
<script lang="ts">
	import { createMutation } from '@tanstack/svelte-query';
	import { report } from '$lib/report';
	import { getWhisperingQueries } from '$lib/whispering/context';

	const queries = getWhisperingQueries();
	const downloadRecording = createMutation(
		() => queries.download.downloadRecording.options,
	);
</script>

<Button
	onclick={() => {
		downloadRecording.mutate(
			recording,
			{
				onSuccess: () => {
					report.success({ title: 'Recording downloaded' });
				},
				onError: (error) => {
					report.error({
						title: 'Failed to download recording',
						cause: error,
					});
				},
			},
		);
	}}
	disabled={downloadRecording.isPending}
>
	{#if downloadRecording.isPending}
		Downloading...
	{:else}
		Download
	{/if}
</Button>
```

Name the mutation after the user action, not with a `Mutation` suffix. The suffix repeats the type and makes templates noisier.

For component-local operation lifecycle, wrap the function locally:

```svelte
<script lang="ts">
	import { createMutation } from '@tanstack/svelte-query';
	import { resultMutationOptions } from 'wellcrafted/query';
	import { exportRecordingsMarkdown } from '$lib/whispering/recordings-markdown-export';
	import { local } from '$lib/whispering/local';
	import { report } from '$lib/report';

	const exportMarkdown = createMutation(() =>
		resultMutationOptions({
			mutationKey: ['recordings', 'exportMarkdown'],
			mutationFn: () => exportRecordingsMarkdown(local),
		}),
	);
</script>

<Button
	onclick={() => {
		exportMarkdown.mutate(undefined, {
			onSuccess: (data) => {
				if (data.status === 'cancelled') return;

				report.success({
					title: 'Recording markdown exported',
					description: `Wrote ${data.written} ${data.written === 1 ? 'file' : 'files'} to ${data.dir}.`,
				});
			},
			onError: (error) => {
				report.error({
					title: 'Recording markdown export failed',
					cause: error,
				});
			},
		});
	}}
	disabled={exportMarkdown.isPending}
>
	{exportMarkdown.isPending ? 'Exporting...' : 'Export markdown...'}
</Button>
```

Do not create a shared query adapter only to get `isPending` for one component. Local `createMutation` gives the component a standard pending/error/success surface without pretending the operation is shared query-layer state.

## Whispering Shared Queries

Read this section when editing Whispering components that use shared query
adapters or component-local operation lifecycles.

Whispering components consume shared query adapters through `.options` inside an
accessor:

```svelte
<script lang="ts">
	import { createMutation } from '@tanstack/svelte-query';
	import { getWhisperingQueries } from '$lib/whispering/context';

	const queries = getWhisperingQueries();

	const transcribeRecording = createMutation(
		() => queries.transcription.transcribeRecording.options,
	);
</script>
```

For a component-local operation lifecycle, do not add a new shared query adapter only to
observe `isPending`. Wrap the operation locally:

```svelte
<script lang="ts">
	import { createMutation } from '@tanstack/svelte-query';
	import { resultMutationOptions } from 'wellcrafted/query';
	import { exportRecordingsMarkdown } from '$lib/whispering/recordings-markdown-export';
	import { local } from '$lib/whispering/local';

	const exportRecordings = createMutation(() =>
		resultMutationOptions({
			mutationKey: ['recordings', 'export'],
			mutationFn: () => exportRecordingsMarkdown(local),
		}),
	);
</script>
```

Whispering error presentation goes through `$lib/report` at the interaction
boundary:

```typescript
if (error !== null) {
	report.error({ cause: error });
	return;
}
```

## Direct Await Pattern

In `.ts` files, use direct `await` because `createMutation` requires component context. For shared Wellcrafted mutations, call the mutation definition directly:

```typescript
// In an interaction controller with an injected query namespace
const { error } = await queries.download.downloadRecording(recording);
if (error !== null) {
	// Handle error
} else {
	// Handle success
}
```

In `.svelte` files, direct `await` is still appropriate when the template does not read pending, success, or error state:

```svelte
<script lang="ts">
	import { clipboard } from '@epicenter/app/clipboard';
	import { toastOnError } from '@epicenter/ui/sonner';
</script>

<Button
	onclick={async () => {
		const { error } = await clipboard.writeText(value);
		if (error !== null) toastOnError(error, 'Could not copy');
	}}
>
	Copy
</Button>
```

If the next edit adds `disabled={isCopying}`, a spinner, or loading text, promote the action to `createMutation` instead of adding a one-off `$state` pending flag. A final toast can consume a Result in the handler without a mutation.

For when a single-use handler should be inlined at its call site versus kept as a named function, see "Single-Use Functions And Aliases" in [component and UI patterns](component-ui-patterns.md).

# Commit-on-Blur for Workspace String Fields

For plain string fields backed by a workspace table or Y.Map row (title, subtitle, name, description, license, label), **commit on `onblur`, not `oninput`**. Per-keystroke writes turn one typing session into N Yjs transactions, N IDB writes, N sync messages, and N BroadcastChannel posts. Commit-on-blur collapses that to one.

The pattern has two halves: the **per-input handler** and the **app-wide safety net**. Both are required: the safety net is what makes commit-on-blur survive Cmd+W mid-edit.

## The handler

```svelte
<input
  type="text"
  value={entry.title}
  onblur={(e) => {
    const next = e.currentTarget.value;
    if (next !== entry.title) updateEntry({ title: next });
  }}
/>
```

The compare-then-write guard avoids a no-op Yjs transaction when focus passes through an unchanged field. For factories that update many fields, extract a small `commit(field, next)` helper that does the compare internally.

## The safety net (app-wide, in `+layout.svelte`)

Render `FlushEditsOnHide` from `@epicenter/svelte` once in the root layout
(ADR-0110):

```svelte
<script lang="ts">
  import { FlushEditsOnHide } from '@epicenter/svelte';
</script>

<FlushEditsOnHide />
```

When the page is being hidden (tab close, Cmd+W, tab switch, window minimize, iOS app-switch, bfcache), the component force-blurs the focused element; `.blur()` synchronously dispatches its blur event, which synchronously runs your commit handler, which synchronously updates the Y.Doc: all before the page tears down. One line in one place, and every `<input onblur>` in the app inherits the resilience.

The guarantee is only as synchronous as the handler. A blur handler that defers its write (`requestAnimationFrame`, `setTimeout`, an `await` before the write) escapes the net: rAF callbacks never run while the document is hidden, and teardown outruns timers. If a handler needs a deferred path for a visible-page focus dance (the tree rename inputs wait one frame so a closing context menu does not cancel the edit), branch on `document.visibilityState === 'hidden'` and commit synchronously in that branch.

Do not hand-roll the two listeners per app: `visibilitychange` is a document event and `pagehide` is a window event, and putting either on the wrong special element typechecks loosely and never fires. The component owns that split (see `packages/svelte/src/flush-edits-on-hide.svelte`).

## The default for new apps

An app ships `<FlushEditsOnHide />` in `+layout.svelte` as soon as it has its first commit-on-blur durable field; an app with none (Todos today) skips it. Once installed it is free, like `<Toaster />` or `<ModeWatcher />`: a layout-level concern with nothing to configure.

## When NOT to use commit-on-blur

| Field type | Pattern |
|---|---|
| Plain string Y.Map field (title, subtitle, name, description, license) | **commit-on-blur** |
| Y.Text bound through y-prosemirror / y-codemirror / tiptap | per-keystroke (CRDT operates at character level) |
| Discrete selectors (radio, checkbox, datepicker, tag pickers) | inline event handler: already one event per action |
| Search box / filter that doesn't persist | local `$state` only, no commit |
| Component-local form state submitted on a button click | accumulate in `$state`, commit in the click handler |

For Y.Text fields you specifically want every keystroke to participate in operational transform: commit-on-blur defeats the point of the CRDT.

## Defensive variant: local state + focus flag

If a sibling tab editing the same row could clobber in-progress typing (rare in personal apps), reach for a local-state buffer with a focus flag: but only if the clobber actually shows up:

```svelte
<script lang="ts">
  let localTitle = $state(entry.title);
  let editing = $state(false);
  $effect(() => { if (!editing) localTitle = entry.title; });
</script>

<input
  bind:value={localTitle}
  onfocus={() => (editing = true)}
  onblur={() => {
    editing = false;
    if (localTitle !== entry.title) commit(localTitle);
  }}
/>
```

For true conflict-free text editing across tabs, switch the field to Y.Text + a CRDT-aware editor binding instead.

See `docs/articles/commit-on-blur-survives-tab-close.md` for the full rationale, persistence-layer reliability table, and the page-lifecycle guarantees behind the safety net.
