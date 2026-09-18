<script lang="ts" module>
	import type { SyncRefusal } from '@epicenter/data/sync';

	// What a refused dial says to a person, mapped exhaustively so a new
	// refusal cannot arrive without a decision about this line. Two arms say
	// nothing: a device with no credential and a window that can never hold one
	// are not conditions to repair here, and a status line about them is noise.
	const REFUSAL_LINE = {
		'signed-out': undefined,
		'reauth-required': 'Sign in to sync',
		'auth-unavailable': 'Offline',
		'no-credential-model': undefined,
	} satisfies Record<SyncRefusal, string | undefined>;
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { AccountPopover } from '@epicenter/app-shell/account-popover';
	import type { SyncConnectionStatus } from '@epicenter/data/sync';
	import * as Collapsible from '@epicenter/ui/collapsible';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { getAuth } from '$lib/auth.svelte.js';
	import type { WorkingCopy } from '@epicenter/data/artifact/checkout';
	import { getHoneycrisp } from '$lib/app.svelte.js';
		import { navigation } from '$lib/navigation.svelte.js';
	import FolderMenuItem from '../components/FolderMenuItem.svelte';
	import PullToFolder from './PullToFolder.svelte';
	import SendFolderEdits from './SendFolderEdits.svelte';

	let {
		librarySelection,
		syncStatus,
		folder,
		removeLocalData,
	}: {
		librarySelection: Snippet;
		syncStatus: () => SyncConnectionStatus | undefined;
		/** The `~/Epicenter` folder, or nothing in a build with no filesystem. */
		folder: WorkingCopy | undefined;
		/** Erase this account's copy and reopen, which only the session can do. */
		removeLocalData?: () => Promise<void>;
	} = $props();

	const auth = getAuth();
	const honeycrisp = getHoneycrisp();
	let sync = $state.raw<SyncConnectionStatus | undefined>(undefined);

	$effect(() => {
		sync = syncStatus();
		const timer = setInterval(() => {
			sync = syncStatus();
		}, 1_000);
		return () => clearInterval(timer);
	});

	const line = $derived.by(() => {
		if (sync === undefined) return undefined;
		if (sync.refusal !== undefined) return REFUSAL_LINE[sync.refusal];
		return `${sync.connected ? 'Synced' : 'Offline'} · ${sync.cursor} changes received`;
	});

	// The tooltip answers for the line above it. Under a refusal that line is
	// about the credential, so the connected-and-caught-up explanation would be
	// answering a question nobody asked.
	const lineTitle = $derived(
		sync?.refusal === undefined
			? 'Whether this device is connected and caught up with your other devices.'
			: undefined,
	);

	// Never shown under a refusal. A window that is refused locally every thirty
	// seconds climbs this count for the life of the page, which says nothing
	// about the network.
	const retries = $derived(
		sync !== undefined &&
			sync.refusal === undefined &&
			!sync.connected &&
			sync.failures > 0
			? sync.failures
			: undefined,
	);

</script>

<Sidebar.Root>
	<Sidebar.Header>
		<div class="flex items-center justify-between px-2 py-1">
			<div class="flex min-w-0 items-center gap-1">
				<span class="text-sm font-semibold">Honeycrisp</span>
			</div>
			<div class="flex items-center gap-1">
				<LightSwitch variant="ghost" />
				<AccountPopover
					{auth}
					syncNoun="notes"
					onRemoveLocalData={removeLocalData}
				/>
				<Sidebar.Trigger />
			</div>
		</div>
		<div class="px-2">{@render librarySelection()}</div>
		<div class="px-2 pb-1">
			<Sidebar.Input
				placeholder="Search notes…"
				value={navigation.query}
				oninput={(e) => navigation.setQuery(e.currentTarget.value)}
			/>
		</div>
	</Sidebar.Header>

	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					<Sidebar.MenuItem>
						<Sidebar.MenuButton
							isActive={navigation.folderId === null && !navigation.isDeletedView}
							onclick={() => navigation.selectFolder(null)}
						>
							<FileTextIcon class="size-4" />
							<span>All Notes</span>
							<span class="ml-auto text-xs text-muted-foreground">
								{honeycrisp.tables.notes.all.length}
							</span>
						</Sidebar.MenuButton>
					</Sidebar.MenuItem>
					<Sidebar.MenuItem>
						<Sidebar.MenuButton
							isActive={navigation.isDeletedView && navigation.folderId === null}
							onclick={() => navigation.selectRecentlyDeleted()}
						>
							<TrashIcon class="size-4" />
							<span>Recently Deleted</span>
							{#if honeycrisp.tables.notes.deleted.length > 0}
								<span class="ml-auto text-xs text-muted-foreground">
									{honeycrisp.tables.notes.deleted.length}
								</span>
							{/if}
						</Sidebar.MenuButton>
					</Sidebar.MenuItem>
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>

		<Collapsible.Root open>
			<Sidebar.Group>
				<Collapsible.Trigger>
					<Sidebar.GroupLabel>Folders</Sidebar.GroupLabel>
				</Collapsible.Trigger>
				<Sidebar.GroupAction
					title="New Folder"
					onclick={() =>
						honeycrisp.tables.folders.create()}
				>
					<PlusIcon />
					<span class="sr-only">New Folder</span>
				</Sidebar.GroupAction>
				<Collapsible.Content>
					<Sidebar.GroupContent>
						<Sidebar.Menu>
							{#each honeycrisp.tables.folders.all as folder (folder.id)}
								<FolderMenuItem {folder} />
							{:else}
								<Sidebar.MenuItem>
									<span class="text-muted-foreground px-2 py-1 text-xs">
										No folders yet
									</span>
								</Sidebar.MenuItem>
							{/each}
						</Sidebar.Menu>
					</Sidebar.GroupContent>
				</Collapsible.Content>
			</Sidebar.Group>
		</Collapsible.Root>
	</Sidebar.Content>

	<Sidebar.Footer>
		{#if folder}
			<SendFolderEdits {folder} />
			<PullToFolder {folder} />
		{/if}
		{#if line !== undefined}
			<div
				class="text-muted-foreground px-2 pb-1 text-[11px] tabular-nums"
				title={lineTitle}
			>
				{line}
				{#if retries !== undefined}
					· {retries} failed {retries === 1 ? 'retry' : 'retries'}
				{/if}
			</div>
		{/if}
	</Sidebar.Footer>

	<Sidebar.Rail />
</Sidebar.Root>
