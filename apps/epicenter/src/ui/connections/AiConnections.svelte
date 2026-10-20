<script lang="ts">
	import { openFolder } from '@epicenter/folder/tauri';
	import {
		createFolderContext,
		type FolderContext,
	} from '@epicenter/svelte/folder';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { onMount } from 'svelte';
	import { extractErrorMessage } from 'wellcrafted/error';
	import ConnectionList from './ConnectionList.svelte';
	import { connectionTables } from './connections';

	/**
	 * Settings' AI connections (ADR-0557): the `connections` table of
	 * Epicenter's own folder, opened with the page's own engine for as long as
	 * Settings is open. The shell binds `so.epicenter` to this window before
	 * it exists, so the page opens its window folder and names none. Its cache
	 * follows the folder's changes,
	 * so an edit made in the Folders window, by an agent, or by a sync shows
	 * here. What is typed is held by each row's edit handle until it saves
	 * (`folder.tables.connections.edit(id)`); leaving Settings sends it
	 * before the folder closes.
	 */
	let local = $state.raw<FolderContext<typeof connectionTables>>();
	let problem = $state<string>();

	onMount(() => {
		let closed = false;
		const opening = (async () => {
			const { data: folder, error } = await openFolder({
				tables: connectionTables,
			});
			if (error !== null) {
				if (!closed) problem = error.message;
				return undefined;
			}
			const context = createFolderContext(folder);
			if (closed) {
				await context.close();
				return undefined;
			}
			local = context;
			return context;
		})().catch((cause: unknown) => {
			if (!closed) problem = extractErrorMessage(cause);
			return undefined;
		});
		return () => {
			closed = true;
			void opening.then((context) => context?.close());
		};
	});
</script>

<div class="grid gap-3 border-b p-3">
	<h2 class="font-medium">AI connections</h2>
	{#if problem}
		<p role="alert" class="text-destructive">Epicenter's folder did not open: {problem}</p>
	{:else if local}
		<QueryClientProvider client={local.queryClient}>
			<ConnectionList {local} />
		</QueryClientProvider>
	{:else}
		<p class="text-muted-foreground">Opening…</p>
	{/if}
</div>
