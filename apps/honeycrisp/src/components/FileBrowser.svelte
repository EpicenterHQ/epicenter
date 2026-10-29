<script lang="ts">
	import * as ContextMenu from '@epicenter/ui/context-menu';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Empty from '@epicenter/ui/empty';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import FileIcon from '@lucide/svelte/icons/file';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import NotebookTextIcon from '@lucide/svelte/icons/notebook-text';
	import { dirname, type TreeRow, visibleRows } from '@epicenter/folder/file-browser';
	import { noteStemOf } from '../data.js';
	import { type Notes } from '../notes.svelte.js';
	import { confirmDelete, copyPath } from './file-actions.js';

	let { notes, openListed }: { notes: Notes; openListed: (path: string) => void } = $props();

	/** Every file this device holds, by path, read again after every change. */
	let paths = $state.raw<string[]>([]);
	$effect(() => {
		notes.repo.revision();
		let current = true;
		void notes.repo.query<{ path: string }>('SELECT path FROM "epicenter/files" WHERE text IS NOT NULL ORDER BY path').then((rows) => {
			if (current && rows.error === null) paths = rows.data.map((row) => row.path);
		});
		return () => {
			current = false;
		};
	});

	/**
	 * The tree over the files this device holds. A directory is there while a
	 * file is in it, and no size is listed, so none is shown.
	 */
	const rows = $derived.by(() => {
		const directories = new Set<string>();
		for (const path of paths)
			for (let at = dirname(path); at !== ''; at = dirname(at)) directories.add(at);
		return visibleRows(
			{ files: paths.map((path) => ({ path, size: 0 })), directories: [...directories] },
			notes.expanded,
		);
	});

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
		openListed(row.path);
	}

	/** The same actions back the right-click menu and the visible "…" menu. */
	function actionGroups(row: TreeRow): Action[][] {
		const copy: Action = { label: 'Copy path', run: () => void copyPath(row.path) };
		if (row.kind === 'directory') return [[copy]];
		const open: Action[] = [{ label: 'Open', shortcut: 'Enter', run: () => activate(row) }, copy];
		if (!notes.deletable(row.path)) return [open];
		return [open, [{ label: 'Delete…', shortcut: 'Del', destructive: true, run: () => confirmDelete(notes, row.path) }]];
	}

	function focusRow(path: string | undefined) {
		if (path === undefined) return;
		tree?.querySelector<HTMLElement>(`[data-row="${CSS.escape(path)}"]`)?.focus();
	}

	/** Arrow keys move between rows and open or close folders; Delete asks to delete a file. */
	function navigate(event: KeyboardEvent) {
		if (!(event.target instanceof HTMLElement)) return;
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
				if (row.kind !== 'file' || !notes.deletable(row.path)) return;
				confirmDelete(notes, row.path);
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

	const indent = (depth: number) => `calc(${depth} * 0.875rem + 0.5rem)`;
</script>

<section class="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
	<div class="flex h-11 shrink-0 items-center gap-1 border-b ps-3 pe-1.5">
		<h2 class="text-sm font-medium">Files</h2>
	</div>

	<p class="truncate border-b px-3 py-1 text-[11px] text-muted-foreground">This repository</p>
		<nav class="min-h-0 flex-1 overflow-y-auto p-1.5" aria-label="Folder files">
			<Sidebar.Menu bind:ref={tree} class="gap-0.5" onkeydown={navigate}>
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
										{:else if noteStemOf(row.path) !== undefined}
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
							<ContextMenu.Content class="min-w-44">
								{#each actionGroups(row) as group, index (index)}
									{#if index > 0}<ContextMenu.Separator />{/if}
									{#each group as action (action.label)}
										<ContextMenu.Item
											variant={action.destructive ? 'destructive' : 'default'}
											disabled={action.disabled}
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
							<DropdownMenu.Content class="min-w-44" align="start">
								{#each actionGroups(row) as group, index (index)}
									{#if index > 0}<DropdownMenu.Separator />{/if}
									{#each group as action (action.label)}
										<DropdownMenu.Item
											variant={action.destructive ? 'destructive' : 'default'}
											disabled={action.disabled}
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
				{:else}
					<li>
						<Empty.Root class="p-6">
							<Empty.Title>No files yet</Empty.Title>
							<Empty.Description>Create a note to see its file here.</Empty.Description>
						</Empty.Root>
					</li>
				{/each}
			</Sidebar.Menu>
		</nav>
</section>
