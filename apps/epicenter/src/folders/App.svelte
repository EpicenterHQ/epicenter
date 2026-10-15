<script lang="ts">
	/**
	 * The Folders window, which is what opening Epicenter shows (ADR-0537):
	 * every data folder under the Epicenter folder, the apps that open each,
	 * every other app, and the one folder opened. The shell lists the folders
	 * (`list_data_folders`) and permits this window into each, so
	 * `openDataFolder({ id })` opens one with its own `epicenter.json`, which
	 * it never writes. One folder is open at a time; choosing another closes
	 * it first. A folder whose `epicenter.json` changes while it is open is
	 * opened again, so its grid follows the new declaration.
	 *
	 * "Open in" launches an app through the same verb as the Apps list and
	 * the Settings button; `openers.ts` decides which apps a folder offers.
	 */
	import type { Folder, FolderDefinition } from '@epicenter/folder';
	import { openDataFolder } from '@epicenter/folder/tauri';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import { onMount } from 'svelte';
	import { SETTINGS_APPLICATION } from '../applications.ts';
	import { commands, type DataFolder } from '../ui/bindings.gen';
	import { createLaunch } from '../ui/launch.svelte.ts';
	import FolderView from './FolderView.svelte';
	import { appsWithoutFolder, openersOf } from './openers.ts';

	let folders = $state<DataFolder[] | undefined>(undefined);
	let listProblem = $state<string | undefined>(undefined);
	let openId = $state<string | undefined>(undefined);
	let opened = $state<Folder<FolderDefinition> | undefined>(undefined);
	let openProblem = $state<string | undefined>(undefined);
	let opening = $state(false);

	/** Choices made while one is still opening keep only the newest. */
	let openSeq = 0;

	const launcher = createLaunch();

	/** Each listed folder with the apps it offers. */
	const listed = $derived(
		(folders ?? []).map((folder) => ({ folder, openers: openersOf(folder) })),
	);
	/** Known once the listing has settled, so an app does not move after it. */
	const apps = $derived(
		folders === undefined && listProblem === undefined
			? undefined
			: appsWithoutFolder(listed.flatMap(({ openers }) => openers)),
	);

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
	<nav class="flex w-80 shrink-0 flex-col overflow-auto border-r" aria-label="Folders">
		<header class="flex items-center justify-between gap-2 px-4 py-3">
			<h1 class="text-lg font-semibold">Folders</h1>
			<Button
				variant="ghost"
				size="sm"
				onclick={() => void launcher.launch(SETTINGS_APPLICATION)}
			>
				{SETTINGS_APPLICATION.title}
			</Button>
		</header>
		{#if launcher.failure}
			<div class="px-3 pb-3">
				<Alert.Root variant="destructive">
					<Alert.Title>Could not open</Alert.Title>
					<Alert.Description>{launcher.failure}</Alert.Description>
				</Alert.Root>
			</div>
		{/if}
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
				{#each listed as { folder, openers } (folder.id)}
					<li class="flex items-center gap-1">
						<button
							type="button"
							aria-current={folder.id === openId ? 'page' : undefined}
							class={[
								'min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted',
								folder.id === openId && 'bg-muted font-medium',
							]}
							onclick={() => open(folder.id)}
						>
							{folder.title}
						</button>
						{#if openers.length === 1}
							{@const application = openers[0]!}
							<Button
								variant="ghost"
								size="xs"
								onclick={() => void launcher.launch(application)}
							>
								Open in {application.title}
							</Button>
						{:else if openers.length > 1}
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button {...props} variant="ghost" size="xs">Open with…</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end">
									{#each openers as application (application.id)}
										<DropdownMenu.Item onclick={() => void launcher.launch(application)}>
											{application.title}
										</DropdownMenu.Item>
									{/each}
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		{#if apps !== undefined && apps.length > 0}
			<h2 class="px-4 pt-2 pb-1 text-sm font-semibold">Apps</h2>
			<ul class="flex flex-col gap-0.5 px-2 pb-3" aria-label="Apps">
				{#each apps as application (application.id)}
					<li class="flex items-center gap-1">
						<span class="min-w-0 flex-1 truncate px-2 py-1.5 text-sm">{application.title}</span>
						<Button
							variant="ghost"
							size="xs"
							onclick={() => void launcher.launch(application)}
						>
							Open
						</Button>
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
