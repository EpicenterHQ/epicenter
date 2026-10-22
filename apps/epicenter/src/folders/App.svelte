<script lang="ts">
	/**
	 * The launcher reads one derived directory list from the native shell.
	 * Row IDs select current membership; paths are displayed, never supplied
	 * as folder grants. Incoming handoffs remain pending until accepted.
	 */
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
	import { onMount } from 'svelte';
	import { commands, type ListedFolder } from '../ui/bindings.gen';
	import { createLaunch } from '../ui/launch.svelte.ts';
	import { bundledOpeners } from './openers.ts';
	import { createFolderOpenings, folderName, FOLDER_OPENINGS_CHANGED } from './openings.svelte.ts';

	let folders = $state.raw<ListedFolder[] | undefined>(undefined);
	let libraryName = $state('Epicenter');
	const groups = $derived([
		{ key: 'pinned', title: 'Pinned', folders: folders?.filter((folder) => folder.group === 'pinned') ?? [] },
		{ key: 'library', title: libraryName, folders: folders?.filter((folder) => folder.group === 'library') ?? [] },
		{ key: 'recent', title: 'Recent', folders: folders?.filter((folder) => folder.group === 'recent') ?? [] },
	] as const);
	let sourceProblems = $state.raw<string[]>([]);
	let listProblem = $state<string | undefined>(undefined);

	/**
	 * The shell's event when the list of data folders may have changed:
	 * `DATA_FOLDERS_CHANGED` in `src-tauri/src/data_folders.rs`, sent to this
	 * window alone.
	 */
	const DATA_FOLDERS_CHANGED = 'epicenter://data-folders-changed';

	const launcher = createLaunch();
	const openings = createFolderOpenings({ host: commands });
	/** Why Settings did not open, when it did not. */
	let settingsProblem = $state<string | undefined>(undefined);

	/** What is being opened, said while the shell opens it. */
	let opening = $state<string | undefined>(undefined);

	/** Listings that resolve out of order keep only the newest. */
	let listSeq = 0;

	async function list() {
		const seq = ++listSeq;
		try {
			const data = await commands.listDataFolders();
			if (seq !== listSeq) return;
			folders = data.folders;
			libraryName = data.libraryName;
			sourceProblems = data.problems;
			listProblem = undefined;
		} catch (error) {
			if (seq !== listSeq) return;
			listProblem = error instanceof Error ? error.message : String(error);
		}
	}

	/** Say what is opening while `work` runs, then list again: a folder may be new. */
	async function opened(what: string, work: () => Promise<void>) {
		opening = `Opening ${what}…`;
		await work();
		opening = undefined;
		await list();
	}

	async function openSettings() {
		settingsProblem = undefined;
		try {
			await commands.openHome(null);
		} catch (cause) {
			settingsProblem = `Settings did not open. ${
				cause instanceof Error ? cause.message : String(cause)
			}`;
		}
	}

	onMount(() => {
		const refreshOpenings = () => {
			void openings.refresh();
			void list();
		};
		// The window's own listener: a global one would hear other windows' events too.
		const stopListing = getCurrentWebviewWindow().listen(
			DATA_FOLDERS_CHANGED,
			() => void list(),
		);
		const stopOpenings = getCurrentWebviewWindow().listen(
			FOLDER_OPENINGS_CHANGED,
			refreshOpenings,
		);
		// Subscribe before reading: a request arriving during startup must not be missed.
		void stopOpenings.then(
			() => void openings.refresh(),
			() => void openings.refresh(),
		);
		void stopListing.then(list, list);
		const stopFocus = getCurrentWebviewWindow().onFocusChanged(({ payload }) => {
			if (payload) refreshOpenings();
		});
		return () => {
			void stopOpenings.then((stop) => stop());
			void stopListing.then((stop) => stop());
			void stopFocus.then((stop) => stop());
		};
	});
</script>

<main class="flex h-full min-h-0 justify-center overflow-auto">
	<div class="flex w-full max-w-xl flex-col gap-2 py-3">
		<header class="flex items-center justify-between gap-2 px-4">
			<h1 class="text-lg font-semibold">Folders</h1>
			<Button variant="ghost" size="sm" onclick={() => void openSettings()}>
				Settings
			</Button>
		</header>
		{#if launcher.failure ?? settingsProblem}
			<div class="px-3">
				<Alert.Root variant="destructive">
					<Alert.Title>Could not finish</Alert.Title>
					<Alert.Description>{launcher.failure ?? settingsProblem}</Alert.Description>
				</Alert.Root>
			</div>
		{/if}
		{#if launcher.notice}
			<p class="px-4 text-sm text-muted-foreground" role="status">{launcher.notice}</p>
		{/if}
		{#each sourceProblems as problem}
			<p class="px-4 text-sm text-destructive" role="alert">{problem}</p>
		{/each}
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
				No folders yet. Open an app to make its default folder, or add a folder under {libraryName}.
			</p>
		{:else}
			{#each groups as group (group.key)}
				{#if group.folders.length > 0}
				<h2 class="px-4 pt-2 text-sm font-semibold">{group.title}</h2>
				<ul class="flex flex-col gap-0.5 px-2" aria-label={group.title}>
				{#each group.folders as folder (folder.id)}
					<li class="flex items-center gap-1">
						<button
							type="button"
							class="min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
							title="Open the files of {folder.title} in a window of their own"
							disabled={folder.problem !== null}
							onclick={() =>
								void opened(folder.title, () => launcher.editFolder(folder.id, folder.title))}
						>
							<span class="block truncate">{folder.title}</span>
							<span class="block truncate text-xs text-muted-foreground" title={folder.path}>
								{folder.path}
							</span>
							{#if folder.defaultFor !== null}
								<span class="block text-xs text-muted-foreground">
									Default for {folder.defaultFor}
								</span>
							{/if}
							{#if folder.problem !== null}
								<span class="block text-xs text-destructive">{folder.problem}</span>
							{:else if folder.temporary}
								<span class="block text-xs text-muted-foreground">Opened this time only</span>
							{/if}
						</button>
						<DropdownMenu.Root>
							<DropdownMenu.Trigger>
								{#snippet child({ props })}
									<Button {...props} variant="ghost" size="xs">Actions</Button>
								{/snippet}
							</DropdownMenu.Trigger>
							<DropdownMenu.Content align="end">
								{#if !folder.protected && folder.problem === null}
									{#each bundledOpeners as application (application.app)}
										<DropdownMenu.Item onclick={() =>
											void opened(application.title, () => launcher.launch(application, folder.id))}>
											Open in {application.title}
										</DropdownMenu.Item>
									{/each}
									<DropdownMenu.Separator />
								{/if}
								{#if folder.group === 'pinned'}
									<DropdownMenu.Item onclick={async () => {
										await launcher.unpin(folder.id, folder.title);
										await list();
									}}>Unpin</DropdownMenu.Item>
								{:else if folder.problem === null}
									<DropdownMenu.Item onclick={async () => {
										await launcher.pin(folder.id, folder.title);
										await list();
									}}>Pin</DropdownMenu.Item>
								{/if}
								{#if folder.recent || folder.temporary}
									<DropdownMenu.Item onclick={async () => {
										await launcher.removeRecent(folder.id, folder.title);
										await list();
									}}>Remove from Recent</DropdownMenu.Item>
								{/if}
							</DropdownMenu.Content>
						</DropdownMenu.Root>
					</li>
				{/each}
				</ul>
				{/if}
			{/each}
		{/if}

		{#if openings.failure}
			<div class="px-3">
				<Alert.Root variant="destructive">
					<Alert.Description>{openings.failure}</Alert.Description>
				</Alert.Root>
			</div>
		{/if}
		{#if openings.notice}
			<p class="px-4 text-sm text-muted-foreground">{openings.notice}</p>
		{/if}
		{#if openings.requests.length > 0}
			<section class="px-4" aria-label="Requests to open folders">
				<h2 class="text-sm font-semibold">Open in Epicenter</h2>
				{#each openings.requests as path (path)}
					<div class="flex items-center gap-2 py-1">
						<div class="min-w-0 flex-1">
							<span class="block truncate">{folderName(path)}</span>
							<span class="block truncate text-xs text-muted-foreground">{path}</span>
						</div>
						<Button
							variant="ghost"
							size="xs"
							disabled={openings.accepting !== undefined}
							onclick={() => void opened(folderName(path), () => openings.accept(path))}
						>
							Open
						</Button>
						<Button
							variant="ghost"
							size="xs"
							disabled={openings.accepting !== undefined}
							onclick={() => void openings.dismiss(path)}
						>
							Dismiss
						</Button>
					</div>
				{/each}
			</section>
		{/if}

		<h2 class="px-4 pt-2 text-sm font-semibold">Apps</h2>
		<ul class="flex flex-col gap-0.5 px-2" aria-label="Apps">
			{#each bundledOpeners as application (application.app)}
				<li class="flex items-center gap-1">
					<span class="min-w-0 flex-1 truncate px-2 py-1.5 text-sm">
						{application.title}
					</span>
					<Button
						variant="ghost"
						size="xs"
						disabled={opening !== undefined}
						onclick={() => void opened(application.title, () => launcher.launch(application))}
					>
						Open
					</Button>
					<Button
						variant="ghost"
						size="xs"
						disabled={opening !== undefined}
						onclick={() => void opened(application.title, () => launcher.choose(application))}
					>
						Choose folder…
					</Button>
				</li>
			{/each}
		</ul>
		{#if opening !== undefined}
			<p class="px-4 text-sm text-muted-foreground" role="status">{opening}</p>
		{/if}
	</div>
</main>
