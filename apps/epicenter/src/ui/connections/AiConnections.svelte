<script lang="ts">
	import {
		folderOptions,
		folderWrites,
		type TableOptions,
		type TableWrites,
	} from '@epicenter/folder/query';
	import { openFolder } from '@epicenter/folder/tauri';
	import { QueryClient, setQueryClientContext } from '@tanstack/svelte-query';
	import { onMount } from 'svelte';
	import {
		EPICENTER_FOLDER_ID,
		epicenterDefinition,
	} from '@epicenter/cli/epicenter-folder';
	import ConnectionList from './ConnectionList.svelte';
	import type { ConnectionFields } from './connections';

	/**
	 * Settings' AI connections (ADR-0557): the `connections` table of
	 * Epicenter's own folder, opened with the page's own engine for as long as
	 * Settings is open. Its cache follows the folder's changes, so an edit made
	 * in the Folders window, by an agent, or by a sync shows here.
	 */
	const queryClient = new QueryClient();
	setQueryClientContext(queryClient);

	/** The connections table's reads and its writes, once the folder opened. */
	let connections = $state.raw<{
		readonly options: TableOptions<ConnectionFields>;
		readonly writes: TableWrites<ConnectionFields>;
	}>();
	let problem = $state<string>();

	onMount(() => {
		queryClient.mount();
		let closed = false;
		let release: (() => Promise<void>) | undefined;
		void (async () => {
			const { data: folder, error } = await openFolder({
				app: EPICENTER_FOLDER_ID,
				definition: epicenterDefinition,
			});
			if (closed) {
				await folder?.close();
				return;
			}
			if (error !== null) {
				problem = error.message;
				return;
			}
			const opened = folderOptions(folder);
			// Subscribed before anything reads, so no change falls between them.
			const stop = opened.invalidateOnChange(queryClient);
			release = async () => {
				stop();
				await folder.close();
			};
			connections = {
				options: opened.tables.connections,
				writes: folderWrites(folder, queryClient).tables.connections,
			};
		})();
		return () => {
			closed = true;
			void release?.();
			queryClient.unmount();
		};
	});
</script>

<div class="grid gap-3 border-b p-3">
	<h2 class="font-medium">AI connections</h2>
	{#if problem}
		<p role="alert" class="text-destructive">Epicenter's folder did not open: {problem}</p>
	{:else if connections}
		<ConnectionList options={connections.options} writes={connections.writes} />
	{:else}
		<p class="text-muted-foreground">Opening…</p>
	{/if}
</div>
