<script lang="ts">
	/**
	 * The Folders window: every data folder under the Epicenter folder, and
	 * the one opened. The shell lists them (`list_data_folders`) and permits
	 * this window into each, so `openDataFolder({ id })` opens one with its
	 * own `epicenter.json`, which it never writes. One folder is open at a
	 * time; choosing another closes it first. A folder whose `epicenter.json`
	 * changes while it is open is opened again, so its grid follows the new
	 * declaration.
	 */
	import type { Folder, FolderDefinition } from '@epicenter/folder';
	import { openDataFolder } from '@epicenter/folder/tauri';
	import * as Alert from '@epicenter/ui/alert';
	import { Badge } from '@epicenter/ui/badge';
	import { onMount } from 'svelte';
	import { commands, type DataFolder } from '../ui/bindings.gen';
	import FolderView from './FolderView.svelte';

	let folders = $state<DataFolder[] | undefined>(undefined);
	let listProblem = $state<string | undefined>(undefined);
	let openId = $state<string | undefined>(undefined);
	let opened = $state<Folder<FolderDefinition> | undefined>(undefined);
	let openProblem = $state<string | undefined>(undefined);
	let opening = $state(false);

	/** Choices made while one is still opening keep only the newest. */
	let openSeq = 0;

	/** The application names `list_data_folders` reports, as a person reads them. */
	const APP_NAMES: Record<string, string> = {
		todos: 'Todos',
		capture: 'Capture',
	};

	async function list() {
		try {
			const { data, error } = await commands.listDataFolders();
			folders = data ?? undefined;
			listProblem = error ?? undefined;
		} catch (error) {
			listProblem = error instanceof Error ? error.message : String(error);
		}
	}

	/** Open folder `id`; `again` reopens the one already open. */
	async function open(id: string, again = false) {
		if (!again && id === openId && (opened !== undefined || opening)) return;
		const seq = ++openSeq;
		openId = id;
		openProblem = undefined;
		opening = true;
		const previous = opened;
		opened = undefined;
		// One handle at a time: closing releases what this window holds.
		await previous?.close();
		const { data, error } = await openDataFolder({ id });
		if (seq !== openSeq) {
			await data?.close();
			return;
		}
		opening = false;
		if (error !== null) {
			openProblem = error.message;
			return;
		}
		opened = data;
	}

	onMount(() => {
		void list();
		return () => void opened?.close();
	});
</script>

<main class="flex h-full min-h-0">
	<nav class="flex w-64 shrink-0 flex-col overflow-auto border-r" aria-label="Folders">
		<h1 class="px-4 py-3 text-lg font-semibold">Folders</h1>
		{#if listProblem !== undefined}
			<div class="px-3">
				<Alert.Root variant="destructive">
					<Alert.Description>Could not list the folders: {listProblem}</Alert.Description>
				</Alert.Root>
			</div>
		{:else if folders === undefined}
			<p class="px-4 text-sm text-muted-foreground">Reading…</p>
		{:else if folders.length === 0}
			<p class="px-4 text-sm text-muted-foreground">
				No data folders yet. A folder in your Epicenter folder that has an epicenter.json shows up here.
			</p>
		{:else}
			<ul class="flex flex-col gap-0.5 px-2 pb-3">
				{#each folders as folder (folder.id)}
					<li>
						<button
							type="button"
							aria-current={folder.id === openId ? 'page' : undefined}
							class={[
								'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted',
								folder.id === openId && 'bg-muted font-medium',
							]}
							onclick={() => open(folder.id)}
						>
							<span class="truncate">{folder.title}</span>
							{#if folder.app !== null}
								<Badge variant="secondary">{APP_NAMES[folder.app] ?? folder.app}</Badge>
							{/if}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</nav>

	<div class="flex min-h-0 min-w-0 flex-1 flex-col">
		{#if openProblem !== undefined}
			<div class="p-4">
				<Alert.Root variant="destructive">
					<Alert.Description>Could not open this folder: {openProblem}</Alert.Description>
				</Alert.Root>
			</div>
		{:else if opening}
			<p class="p-4 text-sm text-muted-foreground">Opening…</p>
		{:else if opened !== undefined}
			{#key opened}
				{@const shown = opened}
				<FolderView
					folder={shown}
					declarationChanged={() => {
						// Only while this folder is still the one shown.
						if (opened === shown && openId !== undefined) void open(openId, true);
					}}
				/>
			{/key}
		{:else}
			<div class="flex flex-1 items-center justify-center p-8 text-center text-muted-foreground">
				Choose a folder to open it.
			</div>
		{/if}
	</div>
</main>
