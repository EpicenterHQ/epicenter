<script lang="ts">
	import type { OpenFolderError } from '@epicenter/folder/tauri';
	import { Button } from '@epicenter/ui/button';
	import ShowFolderButton from './show-folder-button.svelte';

	const {
		app,
		error,
		appDataError = false,
		retry,
	}: {
		/** The app's name, as people know it (`Capture`). */
		app: string;
		/** Why the root did not open. */
		error: OpenFolderError;
		/** Whether the AppData root failed before the data folder opened. */
		appDataError?: boolean;
		/** Open the roots again. */
		retry: () => void;
	} = $props();

	const retrying = $derived($effect.pending() > 0);
</script>

<main class="mx-auto flex w-full max-w-xl flex-col gap-5 px-6 py-12" data-testid="recovery">
	<h1 class="text-lg font-semibold">{appDataError ? `${app} could not open its settings` : `${app} could not open its folder`}</h1>
	{#if error.name === 'Disconnected'}
		<p class="text-sm">This folder is a link to a place that isn't available, such as a disconnected drive.</p>
		<p class="break-all text-sm text-muted-foreground">{error.folder}</p>
	{:else}
		<p class="break-all text-sm">{error.message}</p>
	{/if}
	<div class="flex flex-wrap items-center gap-2">
		<Button disabled={retrying} onclick={retry}>{retrying ? 'Retrying…' : 'Retry'}</Button>
		<ShowFolderButton root={appDataError ? 'AppData' : 'Data'} />
	</div>
</main>
