# Svelte Mutations And Workspace Inputs

Detailed Svelte guidance for TanStack Query mutation placement, inline template actions, and commit-on-blur field editing.

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
	import { getWhisperingApp } from '$lib/whispering/context';
	import { report } from '$lib/report';

	const app = getWhisperingApp();

	const exportMarkdown = createMutation(() =>
		resultMutationOptions({
			mutationKey: ['recordings', 'exportMarkdown'],
			mutationFn: () => exportRecordingsMarkdown(app),
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
	import { getWhisperingApp } from '$lib/whispering/context';

	const app = getWhisperingApp();

	const exportRecordings = createMutation(() =>
		resultMutationOptions({
			mutationKey: ['recordings', 'export'],
			mutationFn: () => exportRecordingsMarkdown(app),
		}),
	);
</script>
```

Whispering error presentation goes through `$lib/report` at the UI or operation
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
<Button
	onclick={async () => {
		await navigator.clipboard.writeText(value);
	}}
>
	Copy
</Button>
```

If the next edit adds `disabled={isCopying}`, a spinner, or loading text, promote the action to `createMutation` instead of adding a one-off `$state` pending flag. A final toast can consume a Result in the handler without a mutation.

For when a single-use handler should be inlined at its call site versus kept as a named function, see "Single-Use Functions And Aliases" in [component and UI patterns](component-ui-patterns.md).

# Commit-on-Blur for Fields Submitted on Blur

This section is for a field whose blur is its submission, such as
Honeycrisp's folder rename (`FolderNav.svelte`, which also commits on Enter).
It does not govern note editors: a note's `edit` saves as the person types and
owns accepted input.

An onblur commit is an explicit submission event with the DOM holding unfinished
input. See [immediate editing and explicit submission](input-ownership.md).

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

The compare-then-write guard avoids a write when focus passes through an
unchanged field. For factories that update many fields, extract a small
`commit(field, next)` helper that does the compare internally.

A blur handler that defers its write (`requestAnimationFrame`, `setTimeout`,
an `await` before the write) can miss a page that is closing: rAF callbacks
never run while the document is hidden, and teardown outruns timers. Write
synchronously in the handler.

## When NOT to use commit-on-blur

| Field type | Pattern |
|---|---|
| A note's fields | the note's editor (`edit`), which saves as the person types |
| Discrete selectors (radio, checkbox, datepicker, tag pickers) | inline event handler: already one event per action |
| Search box / filter that doesn't persist | local `$state` only, no commit |
| Component-local form state submitted on a button click | accumulate in `$state`, commit in the click handler |
