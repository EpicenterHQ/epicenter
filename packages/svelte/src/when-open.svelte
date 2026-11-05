<!--
	The root of an app over its stores (ADR-0766, ADR-0775, ADR-0778): the
	only reader of their lifecycles, rendering the pages once every store the
	page connects to is open, its folder and, where it keeps any, this
	computer's settings. Nothing that reads a store renders before, so every
	read in a page answers what is stored. While they connect, a spinner
	after about 150 ms, and why the folder cannot be reached when it cannot
	(it keeps trying); when one failed, Recovery with the typed error, whose
	Retry is the failure's own `retry()`; once the folder is closed, nothing.
	While open and the folder's store cannot be reached, a status line says
	so, and whether changes are waiting for it (`unavailable()` and
	`saving()`).

	It is also the page's leave guard: while the folder is `saving()`,
	leaving the page asks first (a browser's "Leave site?"). Closing a
	desktop window does not ask the page, so a local write still out then is
	a small, rare loss at the edge (ADR-0702).

	The pages sit in one plain `<svelte:boundary>`: a page that throws shows
	a page error with Try again, never the folder's Recovery, and this
	component catches nothing of the folder's.

	```svelte
	<WhenOpen app="Vocab" {folder} {settings}>{@render children()}</WhenOpen>
	```

	`folder` and `settings` are the app's own, as `reactive` adapts them, the
	same values the pages read.
-->
<script lang="ts">
	import type { FolderLifecycle } from '@epicenter/folder/core';
	import type { Settings } from '@epicenter/local';
	import { Button } from '@epicenter/ui/button';
	import { Loading } from '@epicenter/ui/loading';
	import type { Snippet } from 'svelte';
	import LeaveGuard from './leave-guard.svelte';
	import Recovery from './recovery.svelte';

	let {
		app,
		folder,
		settings,
		children,
	}: {
		/** The app's name, as people know it (`Todos`). */
		app: string;
		/** The folder, adapted by `reactive`: its state tracks. */
		folder: Pick<FolderLifecycle, 'state' | 'unavailable' | 'saving' | 'reveal'>;
		/** This computer's settings, adapted by `reactive`, when the app keeps any. */
		settings?: Pick<Settings, 'state'>;
		/** The pages, once every store is open. */
		children: Snippet;
	} = $props();

	/** How long a connection may take before the spinner shows. */
	const SPINNER_AFTER_MS = 150;

	const folderState = $derived(folder.state());
	const settingsState = $derived(settings?.state() ?? { status: 'open' as const });
	const unavailable = $derived(folder.unavailable());
	/** Why the store cannot be reached, in the store's own words: its cause's message. */
	const reason = $derived.by(() => {
		const cause = unavailable?.cause;
		if (cause instanceof Error) return cause.message;
		if (typeof cause === 'object' && cause !== null && 'message' in cause && typeof cause.message === 'string')
			return cause.message;
		return cause === undefined || cause === null ? '' : String(cause);
	});

	let late = $state(false);
	$effect(() => {
		const timer = setTimeout(() => (late = true), SPINNER_AFTER_MS);
		return () => clearTimeout(timer);
	});
</script>

<LeaveGuard {folder} />

{#if folderState.status === 'failed'}
	<Recovery {app} error={folderState.error} retry={folderState.retry} reveal={folder.reveal} />
{:else if settingsState.status === 'failed'}
	<Recovery {app} appDataError error={settingsState.error} retry={settingsState.retry} />
{:else if folderState.status === 'opening' || settingsState.status === 'opening'}
	{#if late}<Loading class="h-dvh" />{/if}
	{#if unavailable}
		<p class="fixed inset-x-0 bottom-6 px-6 text-center text-sm text-muted-foreground" role="status" data-testid="unreachable">
			Can't reach {app}'s files yet{reason ? ` (${reason})` : ''}. Still trying.
		</p>
	{/if}
{:else if folderState.status === 'open'}
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
