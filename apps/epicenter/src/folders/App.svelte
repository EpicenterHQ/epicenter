<script lang="ts">
	/**
	 * The Folders window, which is what opening Epicenter shows (ADR-0537):
	 * every data folder under the Epicenter folder, the apps that open each,
	 * every other app, and the one folder opened. The shell lists the folders
	 * (`list_data_folders`) and permits this window into each, so
	 * `openFolder({ directory, tables: {} })` opens one by the scope the
	 * listing names. The window knows no app's schema, so it opens every
	 * folder with no tables and edits its files as the text they hold; it
	 * writes nothing on opening. One folder is open at a time
	 * (`folder-switch.svelte.ts`): choosing another first sends what was
	 * typed in the open one and waits for every save; a save that failed
	 * keeps that folder open with its typing, and says which files.
	 *
	 * The open folder is read through TanStack Query, and this root wires the
	 * folder's one channel of change to the cache (ADR-0548): each
	 * `onChange` report invalidates the list and the files it names, or
	 * everything when it names none. The subscription lives exactly as long
	 * as the folder is open. Focus refetch is off: the channel is the one
	 * detector of outside changes. The list of folders is read again when
	 * the shell reports that one appeared, went, or changed its
	 * `epicenter.json` (`DATA_FOLDERS_CHANGED`).
	 *
	 * "Open with" opens an app on that folder through the same verb as the
	 * Apps list, which opens it on its default folder (ADR-0552). Every app
	 * Epicenter bundles and every installed app that can run is offered on
	 * every folder (`openers.ts`, ADR-0560); each app interprets it through
	 * its own table schemas. The Settings button opens Settings with
	 * `open_home`.
	 *
	 * Todos, Capture, Honeycrisp, and Whispering, which Epicenter bundles,
	 * open with `open_bundled_app`: from the Apps list on the app's default
	 * folder under the Epicenter folder, and from "Open with" on the listed
	 * folder, which must still be there. Nothing is installed or approved
	 * for them, and the page passes only the listed scope, never a path. An
	 * installed copy of one of them is not listed.
	 *
	 * Installed apps (ADR-0540) are listed under Apps with what each needs:
	 * an app installed from a folder in a Git repository (`InstallApps`,
	 * ADR-0552) is shown for approval before anything builds, and a commit
	 * fetched from upstream is shown with its log and diff stat while the
	 * approved commit keeps opening (ADR-0597). The `epicenter` CLI installs, updates, approves,
	 * and builds (`app-commands.ts`, ADR-0556), and each step it reports is
	 * said while it runs.
	 */
	import { openFolder } from '@epicenter/folder/tauri';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import { QueryClient, setQueryClientContext } from '@tanstack/svelte-query';
	import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
	import { onMount } from 'svelte';
	import { createLogger } from 'wellcrafted/logger';
	import { commands, type DataFolder } from '../ui/bindings.gen';
	import { createLaunch } from '../ui/launch.svelte.ts';
	import {
		approveApp,
		type InstalledApp,
		listInstalledApps,
		type Review,
		updateApp,
	} from './app-commands.ts';
	import { fileKey, folderKey, listKey } from './files';
	import { createFolderSwitch } from './folder-switch.svelte';
	import FolderView from './FolderView.svelte';
	import InstallApps from './InstallApps.svelte';
	import {
		bundledOpeners,
		folderOpeners,
		listedInstalledApps,
		type Opener,
	} from './openers.ts';

	const log = createLogger('epicenter/folders');

	let folders = $state<DataFolder[] | undefined>(undefined);
	let listProblem = $state<string | undefined>(undefined);

	/**
	 * The shell's event when the list of data folders may have changed:
	 * `DATA_FOLDERS_CHANGED` in `src-tauri/src/data_folders.rs`, sent to this
	 * window alone.
	 */
	const DATA_FOLDERS_CHANGED = 'epicenter://data-folders-changed';

	/**
	 * Epicenter's own folder, `EPICENTER_FOLDER` in
	 * `src-tauri/src/data_folders.rs`, which no bundled app opens.
	 */
	const EPICENTER_FOLDER = 'so.epicenter';

	// Reads reach this computer's disk, and the folder's change channel is
	// the one detector of outside change: a read is fresh until it reports
	// one, and a failure is shown, not retried.
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				networkMode: 'always',
				retry: false,
				staleTime: Number.POSITIVE_INFINITY,
				refetchOnWindowFocus: false,
			},
		},
	});
	setQueryClientContext(queryClient);

	const current = createFolderSwitch({
		open: (id) => openFolder({ directory: id, tables: {} }),
		// Subscribed before anything reads, so no change falls between them.
		// Leaving stops the channel and drops the cache: what the next folder
		// reads is its own.
		watch(id, folder) {
			const stop = folder.onChange((change) => {
				if (change.paths === null) {
					void queryClient.invalidateQueries({ queryKey: folderKey(id) });
					return;
				}
				void queryClient.invalidateQueries({ queryKey: listKey(id) });
				for (const path of change.paths)
					void queryClient.invalidateQueries({ queryKey: fileKey(id, path) });
			});
			return () => {
				stop();
				queryClient.removeQueries({ queryKey: folderKey(id) });
			};
		},
		saved: (id, path) =>
			queryClient.invalidateQueries({ queryKey: fileKey(id, path) }),
	});

	const launcher = createLaunch();
	/** Why Settings did not open, when it did not. */
	let settingsProblem = $state<string | undefined>(undefined);

	let installed = $state<InstalledApp[]>([]);
	/** The installed apps listed under Apps: none is a bundled app's installed copy. */
	const visibleInstalled = $derived(listedInstalledApps(installed));
	let appsProblem = $state<string | undefined>(undefined);
	/** The app whose approval is shown in place of a folder. */
	let reviewing = $state<{ app: InstalledApp; review: Review } | undefined>(
		undefined,
	);
	/** What the shell is doing for an app, said while it does it. */
	let busy = $state<string | undefined>(undefined);

	/** The apps every folder offers; each interprets the opened files through its own schemas. */
	const openers = $derived(folderOpeners(installed));
	/** Each listed folder with the apps it offers: no bundled app opens Epicenter's own. */
	const listed = $derived(
		(folders ?? []).map((folder) => ({
			folder,
			openers:
				folder.id === EPICENTER_FOLDER
					? openers.filter((opener) => opener.kind === 'installed')
					: openers,
		})),
	);
	/** Listings that resolve out of order keep only the newest. */
	let listSeq = 0;

	async function list() {
		const seq = ++listSeq;
		try {
			const { data, error } = await commands.listDataFolders();
			if (seq !== listSeq) return;
			folders = data ?? undefined;
			listProblem = error ?? undefined;
		} catch (error) {
			if (seq !== listSeq) return;
			listProblem = error instanceof Error ? error.message : String(error);
		}
	}

	/** Read the installed apps. */
	async function listInstalled() {
		const { data, error } = await listInstalledApps();
		if (error !== null) {
			appsProblem = error;
			return;
		}
		installed = data;
	}

	/** Show the approval of `app`'s commit waiting for one, when it has one. */
	function review(app: InstalledApp) {
		if (app.pending === null) return;
		reviewing = { app, review: app.pending };
	}

	/**
	 * Run one CLI action for an app, saying what it is doing meanwhile: first
	 * `doing`, then each step the CLI reports.
	 */
	async function act(
		doing: string,
		action: (
			onProgress: (message: string) => void,
		) => Promise<{ data: InstalledApp | null; error: string | null }>,
	): Promise<InstalledApp | undefined> {
		busy = doing;
		appsProblem = undefined;
		try {
			const { data, error } = await action((message) => (busy = message));
			if (error !== null) appsProblem = error;
			return data ?? undefined;
		} catch (cause) {
			appsProblem = cause instanceof Error ? cause.message : String(cause);
			return undefined;
		} finally {
			busy = undefined;
			await listInstalled();
		}
	}

	/** Show the approval of an app `InstallApps` just cloned. */
	async function showInstalled(app: InstalledApp) {
		await listInstalled();
		review(app);
	}

	async function approve(app: InstalledApp, shown: Review) {
		const approved = await act(`Building ${app.title}…`, (onProgress) =>
			approveApp(app.id, shown.commit, onProgress),
		);
		if (approved !== undefined) reviewing = undefined;
	}

	async function update(app: InstalledApp) {
		const updated = await act(`Updating ${app.title}…`, (onProgress) =>
			updateApp(app.id, onProgress),
		);
		if (updated !== undefined) review(updated);
	}

	/**
	 * Open `application` on `folder`, or on its default folder, then read what
	 * opening changed: a bundled app's default folder may be new, and an
	 * installed app's commit may have been built.
	 */
	async function launch(application: Opener, folder?: string) {
		busy = `Opening ${application.title}…`;
		await launcher.launch(application, folder);
		busy = undefined;
		if (application.kind === 'bundled') await list();
		else await listInstalled();
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

	/** Open folder `id`, the scope the shell listed it under. */
	function open(id: string) {
		reviewing = undefined;
		void current.choose(id);
	}

	onMount(() => {
		queryClient.mount();
		// The window's own listener: a global one would hear other windows' events too.
		const stopListing = getCurrentWebviewWindow().listen(
			DATA_FOLDERS_CHANGED,
			() => void list(),
		);
		void list();
		void listInstalled();
		return () => {
			void stopListing.then((stop) => stop());
			void current.close().then((unsaved) => {
				for (const draft of unsaved)
					log.warn(
						new Error(
							`Closed with ${draft.path} unsaved: ${draft.error?.message ?? 'not sent'}`,
						),
					);
				queryClient.unmount();
			});
		};
	});
</script>

<main class="flex h-full min-h-0">
	<nav class="flex w-80 shrink-0 flex-col overflow-auto border-r" aria-label="Folders">
		<header class="flex items-center justify-between gap-2 px-4 py-3">
			<h1 class="text-lg font-semibold">Folders</h1>
			<Button variant="ghost" size="sm" onclick={() => void openSettings()}>
				Settings
			</Button>
		</header>
		{#if launcher.failure ?? settingsProblem}
			<div class="px-3 pb-3">
				<Alert.Root variant="destructive">
					<Alert.Title>Could not open</Alert.Title>
					<Alert.Description>{launcher.failure ?? settingsProblem}</Alert.Description>
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
				No data folders yet. Add a directory under your Epicenter folder to open its files here.
			</p>
		{:else}
			<ul class="flex flex-col gap-0.5 px-2 pb-3">
				{#each listed as { folder, openers } (folder.id)}
					<li class="flex items-center gap-1">
						<button
							type="button"
							aria-current={folder.id === current.chosen ? 'page' : undefined}
							class={[
								'min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted',
								folder.id === current.chosen && 'bg-muted font-medium',
							]}
							onclick={() => open(folder.id)}
						>
							{folder.title}
						</button>
						{#if openers.length > 0}
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button {...props} variant="ghost" size="xs">Open with…</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end">
									{#each openers as application (application.id)}
										<DropdownMenu.Item onclick={() => void launch(application, folder.id)}>
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

		<h2 class="px-4 pt-2 pb-1 text-sm font-semibold">Apps</h2>
		{#if appsProblem !== undefined}
			<div class="px-3 pb-2">
				<Alert.Root variant="destructive">
					<Alert.Description>{appsProblem}</Alert.Description>
				</Alert.Root>
			</div>
		{/if}
		<ul class="flex flex-col gap-0.5 px-2 pb-1" aria-label="Apps">
			{#each bundledOpeners as application (application.id)}
				<li class="flex items-center gap-1">
					<span class="min-w-0 flex-1 truncate px-2 py-1.5 text-sm">
						{application.title}
					</span>
					<Button
						variant="ghost"
						size="xs"
						disabled={busy !== undefined}
						onclick={() => void launch(application)}
					>
						Open
					</Button>
				</li>
			{/each}
			{#each visibleInstalled as app (app.id)}
				<li class="flex items-center gap-1">
					<span class="min-w-0 flex-1 truncate px-2 py-1.5 text-sm" title={app.source}>
						{app.title}
						{#if app.state.kind === 'broken'}
							<span class="block truncate text-xs text-destructive" title={app.state.problem}>
								{app.state.problem}
							</span>
						{:else if app.state.kind === 'needsApproval'}
							<span class="block text-xs text-muted-foreground">Waiting for approval</span>
						{:else if app.pending !== null}
							<span class="block text-xs text-muted-foreground">Update waiting for approval</span>
						{/if}
					</span>
					{#if app.pending !== null && app.state.kind !== 'broken'}
						<Button
							variant="ghost"
							size="xs"
							disabled={busy !== undefined}
							onclick={() => review(app)}
						>
							Review
						</Button>
					{/if}
					{#if app.state.kind === 'ready' || app.state.kind === 'unbuilt'}
						<Button
							variant="ghost"
							size="xs"
							disabled={busy !== undefined}
							onclick={() => void launch({ kind: 'installed', ...app })}
						>
							Open
						</Button>
					{/if}
					{#if app.source !== '' && app.state.kind !== 'broken'}
						<Button
							variant="ghost"
							size="xs"
							disabled={busy !== undefined}
							onclick={() => void update(app)}
						>
							Update
						</Button>
					{/if}
				</li>
			{/each}
		</ul>
		<div class="px-3 pb-3">
			{#if busy !== undefined}
				<p class="px-1 py-1.5 text-sm text-muted-foreground">{busy}</p>
			{:else}
				<InstallApps oninstalled={showInstalled} />
			{/if}
		</div>
	</nav>

	<div class="flex min-h-0 min-w-0 flex-1 flex-col">
		{#if reviewing !== undefined}
			{@const { app, review: shown } = reviewing}
			<section class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-6" aria-label="Approve {app.title}">
				<header class="flex flex-col gap-1">
					<h2 class="text-lg font-semibold">Approve {app.title}?</h2>
					<p class="text-sm text-muted-foreground">
						From {app.source}, at commit
						<code class="font-mono">{shown.commit.slice(0, 12)}</code>
					</p>
				</header>
				<Alert.Root>
					<Alert.Description>{shown.statement}</Alert.Description>
				</Alert.Root>
				<div class="flex flex-col gap-1">
					<h3 class="text-sm font-semibold">
						{shown.from === null ? 'Commits' : 'New commits since you last approved it'}
					</h3>
					<pre class="overflow-auto rounded-md bg-muted p-3 font-mono text-xs">{shown.log || 'None'}</pre>
				</div>
				{#if shown.from !== null}
					<div class="flex flex-col gap-1">
						<h3 class="text-sm font-semibold">Changed files</h3>
						<pre class="overflow-auto rounded-md bg-muted p-3 font-mono text-xs">{shown.diffStat || 'None'}</pre>
					</div>
				{/if}
				<div class="flex gap-2">
					<Button disabled={busy !== undefined} onclick={() => void approve(app, shown)}>
						{busy ?? 'Approve and build'}
					</Button>
					<Button
						variant="ghost"
						disabled={busy !== undefined}
						onclick={() => (reviewing = undefined)}
					>
						Not now
					</Button>
				</div>
			</section>
		{:else if current.problem !== undefined}
			<div class="p-4">
				<Alert.Root variant="destructive">
					<Alert.Description>Could not open this folder: {current.problem}</Alert.Description>
				</Alert.Root>
			</div>
		{:else if current.opening}
			<p class="p-4 text-sm text-muted-foreground">Opening…</p>
		{:else if current.opened !== undefined}
			{@const { id, folder, drafts } = current.opened}
			{#if current.kept !== undefined}
				<Alert.Root variant="destructive" class="rounded-none border-x-0 border-t-0">
					<Alert.Description>
						This folder stayed open because edits did not save:
						{current.kept.map((draft) => draft.path).join(', ')}. Try again or discard
						them, then choose the other folder again.
					</Alert.Description>
				</Alert.Root>
			{/if}
			{#key current.opened}
				<FolderView
					{folder}
					{drafts}
					scope={id}
					title={folders?.find((listed) => listed.id === id)?.title ?? id}
				/>
			{/key}
		{:else}
			<div class="flex flex-1 items-center justify-center p-8 text-center text-muted-foreground">
				Choose a folder to open it.
			</div>
		{/if}
	</div>
</main>
