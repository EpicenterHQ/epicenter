<!--
	The root of an app over its folder (ADR-0766, ADR-0767): the only reader
	of the folder's lifecycle. While the folder opens, a spinner; when it
	failed, Recovery with the typed error, whose Retry opens the folder again
	(`folder.retry()`, nothing else reopens); once it is ready, the pages.

	The pages sit in one plain `<svelte:boundary>`: a page that throws shows
	a page error with Try again, never the folder's Recovery, and this
	component catches nothing of the folder's.

	```svelte
	<Opening app="Todos" {folder}>{@render children()}</Opening>
	```

	`folder` is the app's folder as `fromClient` adapts it, the same value
	the pages read.
-->
<script lang="ts">
	import type { FolderLifecycle, FolderState } from '@epicenter/folder/core';
	import { Button } from '@epicenter/ui/button';
	import { Loading } from '@epicenter/ui/loading';
	import type { Snippet } from 'svelte';
	import Recovery from './recovery.svelte';

	let {
		app,
		folder,
		children,
	}: {
		/** The app's name, as people know it (`Todos`). */
		app: string;
		/** The folder, adapted by `fromClient`: its state tracks. */
		folder: {
			readonly state: FolderState;
			retry(): void;
			readonly reveal: FolderLifecycle['reveal'];
		};
		/** The pages, once the folder is ready. */
		children: Snippet;
	} = $props();
</script>

{#if folder.state.status === 'opening'}
	<Loading class="h-dvh" />
{:else if folder.state.status === 'failed'}
	<Recovery {app} error={folder.state.error} retry={() => folder.retry()} reveal={folder.reveal} />
{:else}
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
