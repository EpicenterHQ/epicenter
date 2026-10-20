<script lang="ts">
	/**
	 * The Folders window, which is what opening Epicenter shows (ADR-0537):
	 * every data folder under the Epicenter folder, the apps that open each,
	 * and the one folder opened. The shell lists the folders
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
	 * Apps list, which opens it on its default folder. Every app Epicenter
	 * bundles, Todos, Capture, Honeycrisp, and Whispering, is offered on
	 * every folder but Epicenter's own (`openers.ts`); each app interprets it
	 * through its own table schemas. Each opens with `open_bundled_app`: from
	 * the Apps list on the app's default folder under the Epicenter folder,
	 * and from "Open with" on the listed folder, which must still be there.
	 * Nothing is installed, built, or approved, and the page passes only the
	 * listed scope, never a path. The Settings button opens Settings with
	 * `open_home`.
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
	import { fileKey, folderKey, listKey } from './files';
	import { createFolderSwitch } from './folder-switch.svelte';
	import FolderView from './FolderView.svelte';
	import { bundledOpeners, type Opener } from './openers.ts';

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

	/** The app being opened, said while the shell opens it. */
	let opening = $state<string | undefined>(undefined);

	/** Each listed folder with the apps it offers: no bundled app opens Epicenter's own. */
	const listed = $derived(
		(folders ?? []).map((folder) => ({
			folder,
			openers: folder.id === EPICENTER_FOLDER ? [] : bundledOpeners,
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
	 * Open `application` on `folder`, or on its default folder, then list the
	 * folders again: its default folder may be new.
	 */
	async function launch(application: Opener, folder?: string) {
		opening = `Opening ${application.title}…`;
		await launcher.launch(application, folder);
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

	/** Open folder `id`, the scope the shell listed it under. */
	function open(id: string) {
		void current.choose(id);
	}

	function settle() {
		const drafts = current.opened?.drafts;
		if (drafts === undefined) return;
		void Promise.allSettled(drafts.held.map((path) => drafts.file(path).save()));
	}

	function beforeUnload(event: BeforeUnloadEvent) {
		if (!current.opened?.drafts.held.length) return;
		event.preventDefault();
		event.returnValue = '';
	}

	onMount(() => {
		queryClient.mount();
		// The window's own listener: a global one would hear other windows' events too.
		const stopListing = getCurrentWebviewWindow().listen(
			DATA_FOLDERS_CHANGED,
			() => void list(),
		);
		void list();
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

<svelte:window onpagehide={settle} onbeforeunload={beforeUnload} />
<svelte:document
	onvisibilitychange={() => {
		if (document.visibilityState === 'hidden') settle();
	}}
/>

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
									{#each openers as application (application.app)}
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
		<ul class="flex flex-col gap-0.5 px-2 pb-1" aria-label="Apps">
			{#each bundledOpeners as application (application.app)}
				<li class="flex items-center gap-1">
					<span class="min-w-0 flex-1 truncate px-2 py-1.5 text-sm">
						{application.title}
					</span>
					<Button
						variant="ghost"
						size="xs"
						disabled={opening !== undefined}
						onclick={() => void launch(application)}
					>
						Open
					</Button>
				</li>
			{/each}
		</ul>
		{#if opening !== undefined}
			<p class="px-4 pb-3 text-sm text-muted-foreground">{opening}</p>
		{/if}
	</nav>

	<div class="flex min-h-0 min-w-0 flex-1 flex-col">
		{#if current.problem !== undefined}
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
