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
	 * The open folder is read through TanStack Query (`folderOptions`), and
	 * this root wires the folder's one channel of change to the cache
	 * (ADR-0548): each `onFilesChanged` report invalidates exactly the
	 * queries it names. The subscription lives exactly as long as the folder
	 * is open. The folder's options turn focus refetch off: the channel is
	 * the one detector of outside changes. The list of folders is read again when the shell
	 * reports that one appeared, went, or changed its `epicenter.json`
	 * (`DATA_FOLDERS_CHANGED`).
	 *
	 * "Open in" opens an installed app on that folder through the same verb
	 * as the Apps list, which opens it on its own folder (ADR-0552);
	 * `openers.ts` decides which apps a folder offers. The Settings button
	 * opens Settings with `open_home`.
	 *
	 * Installed apps (ADR-0540) are listed under Apps with what each needs:
	 * an app installed from a folder in a Git repository (`InstallApps`,
	 * ADR-0552) is shown for approval before anything builds, and an update fetched from upstream is shown again with
	 * its log and diff stat. Each app that runs is recorded as a row of
	 * Epicenter's own folder (`epicenter-folder.ts`).
	 */
	import type { Folder, FolderDefinition } from '@epicenter/folder';
	import { type FolderOptions, folderOptions } from '@epicenter/folder/query';
	import { openDataFolder } from '@epicenter/folder/tauri';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import { QueryClient, setQueryClientContext } from '@tanstack/svelte-query';
	import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
	import { onMount } from 'svelte';
	import type { Application } from '../applications.ts';
	import {
		commands,
		type DataFolder,
		type InstalledApp,
		type Review,
	} from '../ui/bindings.gen';
	import { createLaunch } from '../ui/launch.svelte.ts';
	import { recordInstalledApps } from './epicenter-folder.ts';
	import FolderView from './FolderView.svelte';
	import InstallApps from './InstallApps.svelte';
	import { installedOpeners, openersOf } from './openers.ts';

	let folders = $state<DataFolder[] | undefined>(undefined);
	let listProblem = $state<string | undefined>(undefined);
	let openId = $state<string | undefined>(undefined);
	let opened = $state.raw<
		| {
				readonly folder: Folder<FolderDefinition>;
				readonly options: FolderOptions<FolderDefinition>;
		  }
		| undefined
	>(undefined);
	let openProblem = $state<string | undefined>(undefined);
	let opening = $state(false);

	/** Choices made while one is still opening keep only the newest. */
	let openSeq = 0;

	/**
	 * The shell's event when the list of data folders may have changed:
	 * `DATA_FOLDERS_CHANGED` in `src-tauri/src/data_folders.rs`, sent to this
	 * window alone.
	 */
	const DATA_FOLDERS_CHANGED = 'epicenter://data-folders-changed';

	const queryClient = new QueryClient();
	setQueryClientContext(queryClient);

	/**
	 * Stops the open folder's channel and drops its cache: what the next
	 * folder, or this one opened again with a new declaration, reads is its own.
	 */
	let release: (() => void) | undefined;

	const launcher = createLaunch();
	/** Why Settings did not open, when it did not. */
	let settingsProblem = $state<string | undefined>(undefined);

	let installed = $state<InstalledApp[]>([]);
	let appsProblem = $state<string | undefined>(undefined);
	/** The app whose approval is shown in place of a folder. */
	let reviewing = $state<{ app: InstalledApp; review: Review } | undefined>(
		undefined,
	);
	/** What the shell is doing for an app, said while it does it. */
	let busy = $state<string | undefined>(undefined);

	const openers = $derived(installedOpeners(installed));
	/** Each listed folder with the apps it offers. */
	const listed = $derived(
		(folders ?? []).map((folder) => ({
			folder,
			openers: openersOf(folder, openers),
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

	/**
	 * Read the installed apps, then record each one that runs in Epicenter's
	 * own folder.
	 */
	async function listInstalled() {
		const { data, error } = await commands.listInstalledApps();
		if (error !== null) {
			appsProblem = error;
			return;
		}
		installed = data;
		appsProblem = await recordInstalledApps(data).catch((cause: unknown) =>
			cause instanceof Error ? cause.message : String(cause),
		);
	}

	/** Show `app`'s approval when it needs one. */
	function review(app: InstalledApp) {
		if (app.state.kind !== 'needsApproval') return;
		reviewing = { app, review: app.state.review };
	}

	/** Run one shell action for an app, saying what it is doing meanwhile. */
	async function act(
		doing: string,
		action: () => Promise<{ data: InstalledApp | null; error: string | null }>,
	): Promise<InstalledApp | undefined> {
		busy = doing;
		appsProblem = undefined;
		try {
			const { data, error } = await action();
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

	async function approve(app: InstalledApp) {
		const approved = await act(`Building ${app.title}…`, () =>
			commands.approveApp(app.id, app.commit),
		);
		if (approved !== undefined) reviewing = undefined;
	}

	async function update(app: InstalledApp) {
		const updated = await act(`Updating ${app.title}…`, () =>
			commands.updateApp(app.id),
		);
		if (updated !== undefined) review(updated);
	}

	/** Open `application` on `folder`, then read what building it changed. */
	async function launch(application: Application, folder?: string) {
		busy = `Opening ${application.title}…`;
		await launcher.launch(application, folder);
		busy = undefined;
		await listInstalled();
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

	/** Open folder `id`; `again` reopens the one already open. */
	async function open(id: string, again = false) {
		reviewing = undefined;
		if (!again && id === openId && (opened !== undefined || opening)) return;
		const seq = ++openSeq;
		openId = id;
		openProblem = undefined;
		opening = true;
		const previous = opened;
		opened = undefined;
		release?.();
		release = undefined;
		// One handle at a time: closing releases what this window holds.
		await previous?.folder.close();
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
		const options = folderOptions(data);
		// Subscribed before anything reads, so no change falls between them.
		const stop = options.invalidateOnChange(queryClient);
		release = () => {
			stop();
			queryClient.removeQueries({ queryKey: options.key });
		};
		opened = { folder: data, options };
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
			release?.();
			void opened?.folder.close();
			queryClient.unmount();
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
								onclick={() => void launch(application, folder.id)}
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
			{#each installed as app (app.id)}
				<li class="flex items-center gap-1">
					<span class="min-w-0 flex-1 truncate px-2 py-1.5 text-sm" title={app.source}>
						{app.title}
						{#if app.state.kind === 'broken'}
							<span class="block truncate text-xs text-destructive" title={app.state.problem}>
								{app.state.problem}
							</span>
						{:else if app.state.kind === 'needsApproval'}
							<span class="block text-xs text-muted-foreground">Waiting for approval</span>
						{/if}
					</span>
					{#if app.state.kind === 'needsApproval'}
						<Button
							variant="ghost"
							size="xs"
							disabled={busy !== undefined}
							onclick={() => review(app)}
						>
							Review
						</Button>
					{:else if app.state.kind !== 'broken'}
						<Button
							variant="ghost"
							size="xs"
							disabled={busy !== undefined}
							onclick={() => void launch({ id: app.id, title: app.title })}
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
				<InstallApps offerTodos={installed.length === 0} oninstalled={showInstalled} />
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
						From {app.source || `Apps/${app.id}`}, at commit
						<code class="font-mono">{app.commit.slice(0, 12)}</code>
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
					<Button disabled={busy !== undefined} onclick={() => void approve(app)}>
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
		{:else if openProblem !== undefined}
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
					folder={shown.folder}
					folder$={shown.options}
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
