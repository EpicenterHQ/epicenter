<!--
	The folder's files as a tree. Arrow keys move between rows and open or
	close folders, F2 renames, Delete asks to delete, and the right-click menu
	and the visible "…" menu offer the same actions. Names are typed in place,
	for a rename or a new file or folder.

	What opening a file does, what the app's own items look like, and how a
	create, rename, or delete is carried out and confirmed stay with the app.
-->
<script lang="ts">
	import type { FileListing } from '@epicenter/folder';
	import { basename, dirname, joinPath, type TreeRow, visibleRows } from '@epicenter/folder/file-browser';
	import { Button } from '@epicenter/ui/button';
	import * as ContextMenu from '@epicenter/ui/context-menu';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Loading } from '@epicenter/ui/loading';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { toast } from '@epicenter/ui/sonner';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import FileIcon from '@lucide/svelte/icons/file';
	import FilePlusIcon from '@lucide/svelte/icons/file-plus';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import FolderPlusIcon from '@lucide/svelte/icons/folder-plus';
	import FolderSearchIcon from '@lucide/svelte/icons/folder-search';
	import { type Component, tick } from 'svelte';
	import { copyPath } from './file-actions.js';

	let {
		listing,
		listingError,
		expanded,
		selected,
		icon,
		emptyDescription,
		location,
		onRefresh,
		onReveal,
		onOpen,
		onCreate,
		onRename,
		onDelete,
	}: {
		/** The last listing read, or undefined before the first one. */
		listing: FileListing | undefined;
		/** Why the last read failed; the last listing stays shown. */
		listingError: string | undefined;
		/** The open folders. A reactive set, such as `SvelteSet`, owned by the app. */
		expanded: Set<string>;
		/** Whether a row shows as the open item. */
		selected: (path: string) => boolean;
		/** The icon for one of the app's own items, or undefined for a plain file. */
		icon?: (path: string) => Component | undefined;
		/** What an empty folder suggests doing first. */
		emptyDescription: string;
		/** Where the files are, in words a person can act on, shown under the heading. */
		location?: string;
		onRefresh: () => void;
		/** Show the folder in the system file manager. Returns a problem to show. */
		onReveal?: () => Promise<string | undefined>;
		/** Open a file. Folders open and close in place. */
		onOpen: (path: string) => void;
		/** Create a file or folder. Returns a problem to show, or undefined once it exists. */
		onCreate: (directory: string, name: string, type: 'file' | 'folder') => Promise<string | undefined>;
		/** Returns a problem to show, or undefined once the file has its new name. */
		onRename: (path: string, name: string) => Promise<string | undefined>;
		/** Ask before deleting `path`, and delete it. */
		onDelete: (path: string) => void;
	} = $props();

	const rows = $derived(listing ? visibleRows(listing, expanded) : []);

	/** The inline name field: renaming a file, or creating one in a folder. */
	let editing = $state<
		| { kind: 'rename'; path: string }
		| { kind: 'create'; directory: string; type: 'file' | 'folder' }
		| undefined
	>();
	let committing = false;
	/** The row whose action menu is open, so the keyboard can open it too. */
	let menuPath = $state<string | undefined>();
	let tree = $state<HTMLUListElement | null>(null);

	type Action = {
		label: string;
		shortcut?: string;
		destructive?: boolean;
		disabled?: boolean;
		run: () => void;
	};

	function activate(row: TreeRow) {
		if (row.kind === 'directory') {
			if (expanded.has(row.path)) expanded.delete(row.path);
			else expanded.add(row.path);
			return;
		}
		onOpen(row.path);
	}

	function startCreate(directory: string, type: 'file' | 'folder') {
		if (directory !== '') expanded.add(directory);
		editing = { kind: 'create', directory, type };
	}

	/** The same actions back the right-click menu and the visible "…" menu. */
	function actionGroups(row: TreeRow): Action[][] {
		const copy: Action = { label: 'Copy path', run: () => void copyPath(row.path) };
		const remove = () => onDelete(row.path);
		if (row.kind === 'directory')
			return [
				[
					{ label: 'New file', run: () => startCreate(row.path, 'file') },
					{ label: 'New folder', run: () => startCreate(row.path, 'folder') },
				],
				[copy],
				[
					row.children > 0
						? { label: 'Delete (folder not empty)', destructive: true, disabled: true, run: remove }
						: { label: 'Delete…', shortcut: 'Del', destructive: true, run: remove },
				],
			];
		return [
			[
				{ label: 'Open', shortcut: 'Enter', run: () => activate(row) },
				{ label: 'Rename…', shortcut: 'F2', run: () => (editing = { kind: 'rename', path: row.path }) },
				copy,
			],
			[{ label: 'Delete…', shortcut: 'Del', destructive: true, run: remove }],
		];
	}

	function focusRow(path: string | undefined) {
		if (path === undefined) return;
		tree?.querySelector<HTMLElement>(`[data-row="${CSS.escape(path)}"]`)?.focus();
	}

	/** Arrow keys move between rows and open or close folders; F2 renames; Delete asks to delete. */
	function navigate(event: KeyboardEvent) {
		if (editing !== undefined || !(event.target instanceof HTMLElement)) return;
		const path = event.target.dataset.row;
		const index = rows.findIndex((row) => row.path === path);
		const row = rows[index];
		if (row === undefined) return;
		const open = row.kind === 'directory' && expanded.has(row.path);
		switch (event.key) {
			case 'ArrowDown':
				focusRow(rows[index + 1]?.path);
				break;
			case 'ArrowUp':
				focusRow(rows[index - 1]?.path);
				break;
			case 'Home':
				focusRow(rows[0]?.path);
				break;
			case 'End':
				focusRow(rows.at(-1)?.path);
				break;
			case 'ArrowRight':
				if (row.kind !== 'directory') return;
				if (open) focusRow(rows[index + 1]?.path);
				else expanded.add(row.path);
				break;
			case 'ArrowLeft':
				if (open) expanded.delete(row.path);
				else focusRow(dirname(row.path) || undefined);
				break;
			case 'F2':
				if (row.kind !== 'file') return;
				editing = { kind: 'rename', path: row.path };
				break;
			case 'Delete':
			case 'Backspace':
				onDelete(row.path);
				break;
			case 'ContextMenu':
				menuPath = row.path;
				break;
			case 'F10':
				if (!event.shiftKey) return;
				menuPath = row.path;
				break;
			default:
				return;
		}
		event.preventDefault();
	}

	/** Enter or leaving the field applies the name; Escape or an unchanged name cancels. */
	async function commit(value: string) {
		const current = editing;
		if (current === undefined || committing) return;
		const name = value;
		const directory = current.kind === 'rename' ? dirname(current.path) : current.directory;
		if (name === '' || (current.kind === 'rename' && name === basename(current.path))) {
			await cancel();
			return;
		}
		const action = current.kind === 'rename' ? 'rename' : `create the ${current.type}`;
		committing = true;
		try {
			const problem =
				current.kind === 'rename'
					? await onRename(current.path, name)
					: await onCreate(directory, name, current.type);
			if (problem) {
				toast.error(`Could not ${action}`, { description: problem });
				return;
			}
			editing = undefined;
			await tick();
			focusRow(joinPath(directory, name));
		} catch (cause) {
			toast.error(`Could not ${action}`, {
				description: cause instanceof Error ? cause.message : String(cause),
			});
		} finally {
			committing = false;
		}
	}

	async function cancel() {
		const current = editing;
		editing = undefined;
		await tick();
		focusRow(current?.kind === 'rename' ? current.path : current?.directory || undefined);
	}

	/** Keep focus in a name field a menu item just opened. */
	function keepFieldFocus(event: Event) {
		if (editing !== undefined) event.preventDefault();
	}

	const indent = (depth: number) => `calc(${depth} * 0.875rem + 0.5rem)`;
</script>

{#snippet nameField(initial: string, depth: number, label: string)}
	<form
		class="py-0.5 pe-1"
		style:padding-inline-start={indent(depth)}
		onsubmit={(event) => {
			event.preventDefault();
			const input = event.currentTarget.elements.namedItem('name');
			if (input instanceof HTMLInputElement) void commit(input.value);
		}}
	>
		<Input
			name="name"
			class="h-7"
			value={initial}
			aria-label={label}
			autocomplete="off"
			spellcheck={false}
			{@attach (node: HTMLInputElement) => {
				node.focus();
				// Select the name before its extension, as file managers do.
				const dot = initial.lastIndexOf('.');
				node.setSelectionRange(0, dot > 0 ? dot : initial.length);
			}}
			onkeydown={(event) => {
				if (event.key !== 'Escape') return;
				event.preventDefault();
				void cancel();
			}}
			onblur={(event) => void commit(event.currentTarget.value)}
		/>
	</form>
{/snippet}

{#snippet createField(directory: string, depth: number)}
	{#if editing?.kind === 'create' && editing.directory === directory}
		<li>
			{@render nameField(
				'',
				depth,
				editing.type === 'file'
					? `New file name in ${directory || 'the folder root'}`
					: `New folder name in ${directory || 'the folder root'}`,
			)}
		</li>
	{/if}
{/snippet}

{#snippet actionItems(row: TreeRow, Menu: typeof ContextMenu | typeof DropdownMenu)}
	{#each actionGroups(row) as group, index (index)}
		{#if index > 0}<Menu.Separator />{/if}
		{#each group as action (action.label)}
			<Menu.Item variant={action.destructive ? 'destructive' : 'default'} disabled={action.disabled} onSelect={action.run}>
				{action.label}
				{#if action.shortcut}<Menu.Shortcut>{action.shortcut}</Menu.Shortcut>{/if}
			</Menu.Item>
		{/each}
	{/each}
{/snippet}

<section class="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
	<!-- In a sheet, the sheet's close button takes the top-right corner. -->
	<div class="flex h-11 shrink-0 items-center gap-1 border-b ps-3 pe-1.5 in-data-[slot=sheet-content]:pe-12">
		<h2 class="text-sm font-medium">Files</h2>
		<div class="ml-auto flex items-center">
			{#if onReveal}
				<Button
					variant="ghost"
					size="icon-sm"
					tooltip="Reveal folder"
					aria-label="Reveal folder"
					onclick={async () => {
						const problem = await onReveal();
						if (problem) toast.error('Could not open the folder', { description: problem });
					}}
				>
					<FolderSearchIcon />
				</Button>
			{/if}
			<Button variant="ghost" size="icon-sm" tooltip="New file" aria-label="New file" onclick={() => startCreate('', 'file')}>
				<FilePlusIcon />
			</Button>
			<Button variant="ghost" size="icon-sm" tooltip="New folder" aria-label="New folder" onclick={() => startCreate('', 'folder')}>
				<FolderPlusIcon />
			</Button>
		</div>
	</div>
	{#if location !== undefined}
		<p class="truncate border-b px-3 py-1 font-mono text-[11px] text-muted-foreground" title={location}>
			{location}
		</p>
	{/if}

	{#if listing === undefined}
		{#if listingError}
			<Empty.Root class="flex-1 p-6">
				<Empty.Title>Could not read the folder</Empty.Title>
				<Empty.Description>{listingError}</Empty.Description>
				<Button variant="outline" size="sm" onclick={onRefresh}>Try again</Button>
			</Empty.Root>
		{:else}
			<Loading class="flex-1" label="Reading files…" />
		{/if}
	{:else}
		{#if listingError}
			<p class="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive" role="status">
				Could not read the folder: {listingError}. Showing the last list that was read.
			</p>
		{/if}
		<nav class="min-h-0 flex-1 overflow-y-auto p-1.5" aria-label="Folder files">
			<Sidebar.Menu bind:ref={tree} class="gap-0.5" onkeydown={navigate}>
				{@render createField('', 0)}
				{#each rows as row (row.path)}
					{@const isSelected = selected(row.path)}
					{@const open = row.kind === 'directory' && expanded.has(row.path)}
					{@const ItemIcon = row.kind === 'file' ? icon?.(row.path) : undefined}
					<Sidebar.MenuItem>
						{#if editing?.kind === 'rename' && editing.path === row.path}
							{@render nameField(row.name, row.depth, `New name for ${row.name}`)}
						{:else}
							<ContextMenu.Root>
								<ContextMenu.Trigger>
									{#snippet child({ props })}
										<Sidebar.MenuButton
											{...props}
											size="sm"
											isActive={isSelected}
											data-row={row.path}
											aria-expanded={row.kind === 'directory' ? open : undefined}
											aria-current={isSelected ? 'true' : undefined}
											title={row.path}
											style="padding-inline-start: {indent(row.depth)}"
											onclick={() => activate(row)}
										>
											{#if row.kind === 'directory'}
												{#if open}<FolderOpenIcon />{:else}<FolderIcon />{/if}
											{:else if ItemIcon}
												<ItemIcon />
											{:else if /\.(md|txt|json|ya?ml|csv)$/i.test(row.name) || row.name.startsWith('.')}
												<FileTextIcon />
											{:else}
												<FileIcon />
											{/if}
											<span>{row.name}</span>
										</Sidebar.MenuButton>
									{/snippet}
								</ContextMenu.Trigger>
								<ContextMenu.Content class="min-w-44" onCloseAutoFocus={keepFieldFocus}>
									{@render actionItems(row, ContextMenu)}
								</ContextMenu.Content>
							</ContextMenu.Root>
							<DropdownMenu.Root
								open={menuPath === row.path}
								onOpenChange={(value) => (menuPath = value ? row.path : undefined)}
							>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Sidebar.MenuAction {...props} showOnHover aria-label="Actions for {row.name}">
											<EllipsisIcon />
										</Sidebar.MenuAction>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content class="min-w-44" align="start" onCloseAutoFocus={keepFieldFocus}>
									{@render actionItems(row, DropdownMenu)}
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						{/if}
					</Sidebar.MenuItem>
					{#if open}{@render createField(row.path, row.depth + 1)}{/if}
				{:else}
					{#if editing === undefined}
						<li>
							<Empty.Root class="p-6">
								<Empty.Title>No files yet</Empty.Title>
								<Empty.Description>{emptyDescription}</Empty.Description>
							</Empty.Root>
						</li>
					{/if}
				{/each}
			</Sidebar.Menu>
		</nav>
	{/if}
</section>
