<script lang="ts">
	/**
	 * The Folders window: the folders the `epicenter` CLI syncs, each with its
	 * last round, and the actions on them, each one CLI call the shell runs
	 * (`src-tauri/src/synced_folders.rs`). The shell runs `epicenter sync
	 * --watch` in the background and tells this window when anything changed;
	 * the window then lists again. Below the folders, the apps Epicenter
	 * bundles and hosted sites still open from here.
	 */
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { ConfirmationDialog, confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Dialog from '@epicenter/ui/dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import * as Item from '@epicenter/ui/item';
	import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
	import { onMount } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import {
		type CliError,
		commands,
		type SyncedFolder,
		type SyncedFolderListing,
	} from '../ui/bindings.gen';
	import { createLaunch } from '../ui/launch.svelte.ts';
	import { bundledOpeners } from './openers.ts';
	import SharingDialog from './SharingDialog.svelte';
	import SyncedFolderRow from './SyncedFolderRow.svelte';
	import { SYNCED_FOLDERS_CHANGED } from './synced-folders.ts';

	let listing = $state.raw<SyncedFolderListing | undefined>(undefined);
	let listProblem = $state<string | undefined>(undefined);
	/** The last action's failure. */
	let failure = $state<string | undefined>(undefined);
	/** What `init` or `clone` warned about, such as a missing command link. */
	let notice = $state<string | undefined>(undefined);
	/** What the window is doing to each folder, by path. */
	const busy = new SvelteMap<string, string>();
	/** Adding or cloning a folder, said while it runs. */
	let adding = $state<string | undefined>(undefined);
	let now = $state(Date.now());

	let cloning = $state(false);
	let cloneSource = $state('');
	let sharing = $state.raw<SyncedFolder | undefined>(undefined);

	let siteUrl = $state('');
	let siteProblem = $state<string | undefined>(undefined);
	let siteBusy = $state(false);
	const launcher = createLaunch();

	/** One listing at a time; changes that arrive meanwhile list once more after it. */
	let reading = false;
	let again = false;
	async function list() {
		if (reading) {
			again = true;
			return;
		}
		reading = true;
		try {
			const { data, error } = await commands.syncedFolders();
			if (error !== null) listProblem = error.message;
			else {
				listing = data;
				listProblem = undefined;
			}
		} catch (cause) {
			listProblem = cause instanceof Error ? cause.message : String(cause);
		} finally {
			reading = false;
			now = Date.now();
		}
		if (again) {
			again = false;
			await list();
		}
	}

	/**
	 * Run one CLI action, saying `doing` while it runs, then list again. A
	 * refusal is the window's failure.
	 */
	async function act<T>(
		doing: { folder: string; what: string } | string,
		request: () => Promise<
			{ data: T; error: null } | { data: null; error: CliError | string }
		>,
	): Promise<T | undefined> {
		failure = undefined;
		notice = undefined;
		if (typeof doing === 'string') adding = doing;
		else busy.set(doing.folder, doing.what);
		try {
			const { data, error } = await request();
			if (error !== null) {
				failure = typeof error === 'string' ? error : error.message;
				return undefined;
			}
			return data;
		} catch (cause) {
			failure = cause instanceof Error ? cause.message : String(cause);
			return undefined;
		} finally {
			if (typeof doing === 'string') adding = undefined;
			else busy.delete(doing.folder);
			await list();
		}
	}

	function warn(warnings: string[] | undefined) {
		if (warnings !== undefined && warnings.length > 0) notice = warnings.join(' ');
	}

	async function openSettings() {
		failure = undefined;
		try {
			await commands.openHome(null);
		} catch (cause) {
			failure = `Settings did not open. ${cause instanceof Error ? cause.message : String(cause)}`;
		}
	}

	async function openSite(url: string) {
		siteBusy = true;
		siteProblem = undefined;
		try {
			const result = await commands.openHostedSite(url);
			if (result.error !== null) throw new Error(result.error);
			siteUrl = '';
		} catch (cause) {
			siteProblem = cause instanceof Error ? cause.message : String(cause);
		} finally {
			siteBusy = false;
		}
	}

	onMount(() => {
		const current = getCurrentWebviewWindow();
		// The window's own listener: a global one would hear other windows' events too.
		const stopListening = current.listen(SYNCED_FOLDERS_CHANGED, () => void list());
		// Subscribe before reading: a change arriving during startup must not be missed.
		void stopListening.then(list, list);
		const stopFocus = current.onFocusChanged(({ payload }) => {
			if (payload) void list();
		});
		const clock = setInterval(() => (now = Date.now()), 30_000);
		return () => {
			clearInterval(clock);
			void stopListening.then((stop) => stop());
			void stopFocus.then((stop) => stop());
		};
	});
</script>

<main class="flex h-full min-h-0 justify-center overflow-auto">
	<div class="flex w-full max-w-xl flex-col gap-4 px-4 py-4">
		<header class="flex items-center justify-between gap-2">
			<h1 class="text-lg font-semibold">Folders</h1>
			<div class="flex items-center gap-1">
				<Button
					size="sm"
					disabled={adding !== undefined}
					onclick={async () =>
						warn(
							(await act('Setting up the folder…', () => commands.addSyncedFolder()))
								?.warnings,
						)}
				>
					Add folder
				</Button>
				<Button
					size="sm"
					variant="outline"
					disabled={adding !== undefined}
					onclick={() => (cloning = true)}
				>
					Clone
				</Button>
				<Button size="sm" variant="ghost" onclick={() => void openSettings()}>Settings</Button>
			</div>
		</header>

		{#if failure ?? launcher.failure}
			<Alert.Root variant="destructive">
				<Alert.Title>Could not finish</Alert.Title>
				<Alert.Description>{failure ?? launcher.failure}</Alert.Description>
			</Alert.Root>
		{/if}
		{#if notice}
			<p class="text-sm text-muted-foreground" role="status">{notice}</p>
		{/if}
		{#if adding}
			<p class="text-sm text-muted-foreground" role="status">{adding}</p>
		{/if}

		{#if listing !== undefined}
			{#if listing.service.state === 'stopped'}
				<Alert.Root>
					<Alert.Title>Syncing is paused</Alert.Title>
					<Alert.Description>
						<p>
							<code>epicenter sync --watch</code> stopped: {listing.service.reason}
						</p>
						<Button
							class="mt-2"
							size="sm"
							variant="outline"
							onclick={async () => {
								await commands.restartSyncService();
								await list();
							}}
						>
							Start syncing again
						</Button>
					</Alert.Description>
				</Alert.Root>
			{/if}

			{#if listing.setups.length > 0}
				<section class="flex flex-col gap-2" aria-label="Requests to sync folders">
					{#each listing.setups as setup (setup.path)}
						<Item.Root variant="outline" size="sm">
							<Item.Content class="min-w-0">
								<Item.Title>Sync this folder?</Item.Title>
								<Item.Description class="truncate" title={setup.path}>
									{setup.path}
								</Item.Description>
								{#if setup.contract !== null}
									<p class="truncate text-xs text-muted-foreground" title={setup.contract}>
										For {setup.contract}
									</p>
								{/if}
							</Item.Content>
							<Item.Actions>
								<Button
									size="sm"
									disabled={adding !== undefined}
									onclick={async () =>
										warn(
											(
												await act('Setting up the folder…', () =>
													commands.acceptFolderSetup(setup.path),
												)
											)?.warnings,
										)}
								>
									Set up
								</Button>
								<Button
									size="sm"
									variant="ghost"
									onclick={async () => {
										await commands.dismissFolderSetup(setup.path);
										await list();
									}}
								>
									Dismiss
								</Button>
							</Item.Actions>
						</Item.Root>
					{/each}
				</section>
			{/if}
		{/if}

		<section class="flex flex-col gap-1" aria-label="Synced folders">
			{#if listProblem !== undefined}
				<Alert.Root variant="destructive">
					<Alert.Description>Could not list the folders: {listProblem}</Alert.Description>
				</Alert.Root>
			{:else if listing === undefined}
				<p class="text-sm text-muted-foreground">Reading…</p>
			{:else if listing.folders.length === 0}
				<Empty.Root class="border">
					<Empty.Header>
						<Empty.Title>No folders sync yet</Empty.Title>
						<Empty.Description>
							Add a folder on this computer, or clone one of your repositories. Epicenter
							commits, merges, and pushes it in the background.
						</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{:else}
				<Item.Group class="gap-1">
					{#each listing.folders as folder (folder.path)}
						<SyncedFolderRow
							{folder}
							{now}
							busy={busy.get(folder.path)}
							onSync={() =>
								void act({ folder: folder.path, what: 'Syncing…' }, () =>
									commands.syncFolderNow(folder.path),
								)}
							onOpen={() =>
								void act({ folder: folder.path, what: 'Opening…' }, () =>
									commands.openSyncedFolder(folder.path),
								)}
							onShare={() => (sharing = folder)}
							onForget={() =>
								confirmationDialog.open({
									title: `Stop syncing ${folder.name}?`,
									description:
										'Its files and history stay where they are. Epicenter stops committing, merging, and pushing them.',
									confirm: { text: 'Stop syncing', variant: 'destructive' },
									async onConfirm() {
										await act({ folder: folder.path, what: 'Stopping…' }, () =>
											commands.forgetSyncedFolder(folder.path),
										);
									},
								})}
						/>
					{/each}
				</Item.Group>
			{/if}
		</section>

		<section class="flex flex-col gap-1 pt-2" aria-label="Apps">
			<h2 class="text-sm font-semibold">Apps</h2>
			<ul class="flex flex-col">
				{#each bundledOpeners as application (application.app)}
					<li class="flex items-center gap-1">
						<span class="min-w-0 flex-1 truncate py-1.5 text-sm">{application.title}</span>
						<Button variant="ghost" size="xs" onclick={() => void launcher.launch(application)}>
							Open
						</Button>
						<Button variant="ghost" size="xs" onclick={() => void launcher.choose(application)}>
							Choose folder…
						</Button>
					</li>
				{/each}
			</ul>
		</section>

		<section class="flex flex-col gap-1" aria-label="Sites">
			<h2 class="text-sm font-semibold">Sites</h2>
			<form
				class="flex gap-2"
				onsubmit={(event) => {
					event.preventDefault();
					void openSite(siteUrl.trim());
				}}
			>
				<Input
					aria-label="Site URL"
					type="url"
					placeholder="https://todos.example.com"
					bind:value={siteUrl}
					required
				/>
				<Button type="submit" size="sm" variant="outline" disabled={siteBusy}>Open</Button>
			</form>
			{#if siteProblem}
				<p class="text-sm text-destructive" role="alert">{siteProblem}</p>
			{/if}
		</section>
	</div>
</main>

<Dialog.Root bind:open={cloning}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Clone a repository</Dialog.Title>
			<Dialog.Description>
				Its files land in a new folder in your Epicenter folder and sync from then on.
			</Dialog.Description>
		</Dialog.Header>
		<form
			class="flex flex-col gap-3"
			onsubmit={async (event) => {
				event.preventDefault();
				const source = cloneSource.trim();
				cloning = false;
				const cloned = await act(`Cloning ${source}…`, () => commands.cloneSyncedFolder(source));
				if (cloned !== undefined) cloneSource = '';
				warn(cloned?.warnings);
			}}
		>
			<Input
				aria-label="Repository"
				placeholder="owner/name or a URL"
				bind:value={cloneSource}
				required
			/>
			<Dialog.Footer>
				<Button type="submit" disabled={cloneSource.trim() === ''}>Clone</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

{#if sharing !== undefined}
	<SharingDialog folder={sharing} onClose={() => (sharing = undefined)} />
{/if}
<ConfirmationDialog />
