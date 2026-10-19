<script lang="ts">
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
	import NotebookTextIcon from '@lucide/svelte/icons/notebook-text';
	import { tick } from 'svelte';
	import { dirname, joinPath, type TreeRow, visibleRows } from '@epicenter/folder/file-browser';
	import { createQuery } from '@tanstack/svelte-query';
	import { noteIdOf } from '$lib/data.js';
	import type { Notes } from '$lib/notes.svelte.js';
	import { confirmDelete, copyPath } from './file-actions.js';

	let { notes }: { notes: Notes } = $props();

	const listing = createQuery(() => notes.filesQuery());
	/**
	 * The tree over the listing. The folder lists file paths only: a directory
	 * is there while a file is in it, and no size is listed, so none is shown.
	 */
	const rows = $derived.by(() => {
		if (listing.data === undefined) return [];
		const directories = new Set<string>();
		for (const path of listing.data)
			for (let at = dirname(path); at !== ''; at = dirname(at)) directories.add(at);
		return visibleRows(
			{ files: listing.data.map((path) => ({ path, size: 0 })), directories: [...directories] },
			notes.expanded,
		);
	});

	/** The inline name field: creating a file in a folder. */
	let editing = $state<{ directory: string } | undefined>();
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
			if (notes.expanded.has(row.path)) notes.expanded.delete(row.path);
			else notes.expanded.add(row.path);
			return;
		}
		notes.open(row.path);
	}

	function startCreate(directory: string) {
		if (directory !== '') notes.expanded.add(directory);
		editing = { directory };
	}

	/** The same actions back the right-click menu and the visible "…" menu. */
	function actionGroups(row: TreeRow): Action[][] {
		const copy: Action = { label: 'Copy path', run: () => void copyPath(row.path) };
		if (row.kind === 'directory')
			return [[{ label: 'New file', run: () => startCreate(row.path) }], [copy]];
		return [
			[{ label: 'Open', shortcut: 'Enter', run: () => activate(row) }, copy],
			[
				{
					label: 'Delete…',
					shortcut: 'Del',
					destructive: true,
					run: () => void confirmDelete(notes, row.path),
				},
			],
		];
	}

	function focusRow(path: string | undefined) {
		if (path === undefined) return;
		tree?.querySelector<HTMLElement>(`[data-row="${CSS.escape(path)}"]`)?.focus();
	}

	/** Arrow keys move between rows and open or close folders; Delete asks to delete a file. */
	function navigate(event: KeyboardEvent) {
		if (editing !== undefined || !(event.target instanceof HTMLElement)) return;
		const path = event.target.dataset.row;
		const index = rows.findIndex((row) => row.path === path);
		const row = rows[index];
		if (row === undefined) return;
		const open = row.kind === 'directory' && notes.expanded.has(row.path);
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
				else notes.expanded.add(row.path);
				break;
			case 'ArrowLeft':
				if (open) notes.expanded.delete(row.path);
				else focusRow(dirname(row.path) || undefined);
				break;
			case 'Delete':
			case 'Backspace':
				if (row.kind !== 'file') return;
				void confirmDelete(notes, row.path);
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

	/** Enter or leaving the field creates the file; Escape or an empty name cancels. */
	async function commit(name: string) {
		const current = editing;
		if (current === undefined || committing) return;
		const { directory } = current;
		if (name === '') {
			await cancel();
			return;
		}
		committing = true;
		try {
			const problem = await notes.createFile(directory, name);
			if (problem) {
				toast.error('Could not create the file', { description: problem });
				return;
			}
			editing = undefined;
			await tick();
			focusRow(joinPath(directory, name));
		} catch (cause) {
			toast.error('Could not create the file', {
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
		focusRow(current?.directory || undefined);
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
			{@attach (node: HTMLInputElement) => node.focus()}
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
	{#if editing?.directory === directory}
		<li>{@render nameField('', depth, `New file name in ${directory || 'the folder root'}`)}</li>
	{/if}
{/snippet}

<section class="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
	<div class="flex h-11 shrink-0 items-center gap-1 border-b ps-3 pe-1.5">
		<h2 class="text-sm font-medium">Files</h2>
		<div class="ml-auto flex items-center">
			<Button variant="ghost" size="icon-sm" tooltip="New file" aria-label="New file" onclick={() => startCreate('')}>
				<FilePlusIcon />
			</Button>
		</div>
	</div>

	<p class="truncate border-b px-3 py-1 text-[11px] text-muted-foreground">This folder</p>
	{#if listing.data === undefined}
		{#if listing.isError}
			<Empty.Root class="flex-1 p-6">
				<Empty.Title>Could not read the folder</Empty.Title>
				<Empty.Description>{listing.error.message}</Empty.Description>
				<Button variant="outline" size="sm" onclick={() => void listing.refetch()}>Try again</Button>
			</Empty.Root>
		{:else}
			<Loading class="flex-1" label="Reading files…" />
		{/if}
	{:else}
		{#if listing.isError}
			<p class="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive" role="status">
				Could not read the folder: {listing.error.message}. Showing the last list that was read.
			</p>
		{/if}
		<nav class="min-h-0 flex-1 overflow-y-auto p-1.5" aria-label="Folder files">
			<Sidebar.Menu bind:ref={tree} class="gap-0.5" onkeydown={navigate}>
				{@render createField('', 0)}
				{#each rows as row (row.path)}
					{@const selected = notes.selected?.path === row.path}
					{@const open = row.kind === 'directory' && notes.expanded.has(row.path)}
					<Sidebar.MenuItem>
						<ContextMenu.Root>
							<ContextMenu.Trigger>
								{#snippet child({ props })}
									<Sidebar.MenuButton
										{...props}
										size="sm"
										isActive={selected}
										data-row={row.path}
										aria-expanded={row.kind === 'directory' ? open : undefined}
										aria-current={selected ? 'true' : undefined}
										title={row.path}
										style="padding-inline-start: {indent(row.depth)}"
										onclick={() => activate(row)}
									>
										{#if row.kind === 'directory'}
											{#if open}<FolderOpenIcon />{:else}<FolderIcon />{/if}
										{:else if noteIdOf(row.path) !== undefined}
											<NotebookTextIcon />
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
								{#each actionGroups(row) as group, index (index)}
									{#if index > 0}<ContextMenu.Separator />{/if}
									{#each group as action (action.label)}
										<ContextMenu.Item
											variant={action.destructive ? 'destructive' : 'default'}
											disabled={action.disabled || notes.fenced}
											onSelect={action.run}
										>
											{action.label}
											{#if action.shortcut}<ContextMenu.Shortcut>{action.shortcut}</ContextMenu.Shortcut>{/if}
										</ContextMenu.Item>
									{/each}
								{/each}
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
								{#each actionGroups(row) as group, index (index)}
									{#if index > 0}<DropdownMenu.Separator />{/if}
									{#each group as action (action.label)}
										<DropdownMenu.Item
											variant={action.destructive ? 'destructive' : 'default'}
											disabled={action.disabled || notes.fenced}
											onSelect={action.run}
										>
											{action.label}
											{#if action.shortcut}<DropdownMenu.Shortcut>{action.shortcut}</DropdownMenu.Shortcut>{/if}
										</DropdownMenu.Item>
									{/each}
								{/each}
							</DropdownMenu.Content>
						</DropdownMenu.Root>
					</Sidebar.MenuItem>
					{#if open}{@render createField(row.path, row.depth + 1)}{/if}
				{:else}
					{#if editing === undefined}
						<li>
							<Empty.Root class="p-6">
								<Empty.Title>No files yet</Empty.Title>
								<Empty.Description>Create a note, or a file above.</Empty.Description>
							</Empty.Root>
						</li>
					{/if}
				{/each}
			</Sidebar.Menu>
		</nav>
	{/if}
</section>
