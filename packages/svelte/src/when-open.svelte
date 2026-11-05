<!--
	The root of an app over its folder (ADR-0766, ADR-0767, ADR-0775): the
	only reader of the folder's lifecycle, rendering the pages when the folder
	is open. While it opens, a spinner, and why the store cannot be reached
	when it cannot (the folder keeps trying); when it failed, Recovery with
	the typed error, whose Retry is the failure's own `retry()`; once it is
	closed, nothing. While open and the store cannot be reached, a status
	line says so, and whether changes are waiting for it (`unavailable()`
	and `saving()`).

	It is also the page's leave guard: while the folder is `saving()`,
	leaving the page asks first (a browser's "Leave site?"). Closing a
	desktop window does not ask the page, so a local write still out then is
	a small, rare loss at the edge (ADR-0702).

	The pages sit in one plain `<svelte:boundary>`: a page that throws shows
	a page error with Try again, never the folder's Recovery, and this
	component catches nothing of the folder's.

	```svelte
	<WhenOpen app="Todos" {folder}>{@render children()}</WhenOpen>
	```

	`folder` is the app's folder as `reactive` adapts it, the same value the
	pages read.
-->
<script lang="ts">
	import type { FolderLifecycle } from '@epicenter/folder/core';
	import { Button } from '@epicenter/ui/button';
	import { Loading } from '@epicenter/ui/loading';
	import type { Snippet } from 'svelte';
	import LeaveGuard from './leave-guard.svelte';
	import Recovery from './recovery.svelte';

	let {
		app,
		folder,
		children,
	}: {
		/** The app's name, as people know it (`Todos`). */
		app: string;
		/** The folder, adapted by `reactive`: its state tracks. */
		folder: Pick<FolderLifecycle, 'state' | 'unavailable' | 'saving' | 'reveal'>;
		/** The pages, once the folder is open. */
		children: Snippet;
	} = $props();

	const state = $derived(folder.state());
	const unavailable = $derived(folder.unavailable());
	/** Why the store cannot be reached, in the store's own words: its cause's message. */
	const reason = $derived.by(() => {
		const cause = unavailable?.cause;
		if (cause instanceof Error) return cause.message;
		if (typeof cause === 'object' && cause !== null && 'message' in cause && typeof cause.message === 'string')
			return cause.message;
		return cause === undefined || cause === null ? '' : String(cause);
	});
</script>

<LeaveGuard {folder} />

{#if state.status === 'opening'}
	<Loading class="h-dvh" />
	{#if unavailable}
		<p class="fixed inset-x-0 bottom-6 px-6 text-center text-sm text-muted-foreground" role="status" data-testid="unreachable">
			Can't reach {app}'s files yet{reason ? ` (${reason})` : ''}. Still trying.
		</p>
	{/if}
{:else if state.status === 'failed'}
	<Recovery {app} error={state.error} retry={state.retry} reveal={folder.reveal} />
{:else if state.status === 'open'}
	{#if unavailable}
		<p class="bg-muted px-4 py-1 text-center text-xs text-muted-foreground" role="status" data-testid="unreachable">
			Can't reach {app}'s files right now{reason ? ` (${reason})` : ''}.
			{folder.saving() ? 'Your changes will save once they can be reached.' : 'What you see may be out of date.'}
		</p>
	{/if}
	<svelte:boundary>
		{@render children()}
		{#snippet failed(error, reset)}
			<main class="mx-auto flex w-full max-w-xl flex-col gap-5 px-6 py-12" data-testid="page-error">
				<h1 class="text-lg font-semibold">This page stopped working</h1>
				<p class="break-all text-sm">{error instanceof Error ? error.message : String(error)}</p>
				<div>
					<Button onclick={reset}>Try again</Button>
				</div>
			</main>
		{/snippet}
	</svelte:boundary>
{/if}
