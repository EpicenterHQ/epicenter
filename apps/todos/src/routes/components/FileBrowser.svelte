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
	import FolderPlusIcon from '@lucide/svelte/icons/folder-plus';
	import ListTodoIcon from '@lucide/svelte/icons/list-todo';
	import { tick, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		ancestorsOf,
		basename,
		dirname,
		joinPath,
		type TreeRow,
		visibleRows,
	} from '@epicenter/folder/file-browser';
	import { createQuery } from '@tanstack/svelte-query';
	import { describeError } from '$lib/describe-error.js';
	import { todoPath } from '$lib/todo-listing.js';
	import { getTodos } from '$lib/todos.svelte.js';
	import { confirmDelete, copyPath } from './file-actions.js';

	const todos = getTodos();

	let { onOpen }: { onOpen?: () => void } = $props();

	const listing = createQuery(() => todos.files.list.options);
	/** Every todo row file, whether or not its text reads as a todo. */
	const todoPaths = createQuery(() =>
		({ ...todos.rows.list.options, select: (entries) => new Set(entries.map(({ stem }) => todoPath(stem))) }),
	);
	/** Folders open here. They go with the browser: hiding it forgets them. */
	const expanded = new SvelteSet<string>(['todos']);
	// Show the file the detail opens as a file: when the browser mounts, and
	// each time the selection changes. The person can still close any folder.
	$effect.pre(() => {
		const shown = todos.selected;
		if (shown?.as !== 'files') return;
		untrack(() => {
			for (const ancestor of ancestorsOf(shown.path)) expanded.add(ancestor);
		});
	});
	const rows = $derived(listing.data ? visibleRows(listing.data, expanded) : []);

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
		todos.select(row.path, 'files');
		onOpen?.();
	}

	function startCreate(directory: string, type: 'file' | 'folder') {
		if (directory !== '') expanded.add(directory);
		editing = { kind: 'create', directory, type };
	}

	/** The same actions back the right-click menu and the visible "…" menu. */
	function actionGroups(row: TreeRow): Action[][] {
		const copy: Action = { label: 'Copy path', run: () => void copyPath(row.path) };
		const remove = () => void confirmDelete(todos, row.path);
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
				void confirmDelete(todos, row.path);
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
		// While Epicenter asks to quit or restart, the field and its typed name
		// stay as they are; disabling it blurs it, which commits nothing.
		if (current === undefined || committing || todos.departing) return;
		const name = value;
		const directory = current.kind === 'rename' ? dirname(current.path) : current.directory;
		if (name === '' || (current.kind === 'rename' && name === basename(current.path))) {
			await cancel();
			return;
		}
		committing = true;
		const { error } =
			current.kind === 'rename'
				? await todos.files.rename(current.path, name)
				: current.type === 'file'
					? await todos.files.createFile({ directory, name })
					: await todos.files.createFolder({ directory, name });
		committing = false;
		if (error !== null) {
			const action =
				current.kind === 'rename' ? 'rename' : `create the ${current.type}`;
			toast.error(`Could not ${action}`, { description: describeError(error) });
			return;
		}
		editing = undefined;
		if (current.kind === 'create' && current.type === 'file') onOpen?.();
		await tick();
		focusRow(joinPath(directory, name));
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

<section class="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
	<!-- On narrow screens this sits in a sheet whose close button takes the top-right corner. -->
	<div class="flex h-11 shrink-0 items-center gap-1 border-b ps-3 pe-12 md:pe-1.5">
		<h2 class="text-sm font-medium">Files</h2>
		<div class="ml-auto flex items-center">
			<Button variant="ghost" size="icon-sm" tooltip="New file" aria-label="New file" onclick={() => startCreate('', 'file')}>
				<FilePlusIcon />
			</Button>
			<Button variant="ghost" size="icon-sm" tooltip="New folder" aria-label="New folder" onclick={() => startCreate('', 'folder')}>
				<FolderPlusIcon />
			</Button>
		</div>
	</div>

	{#if listing.data === undefined}
		{#if listing.isError}
			<Empty.Root class="flex-1 p-6">
				<Empty.Title>Could not read the folder</Empty.Title>
				<Empty.Description>{listing.error.message}</Empty.Description>
				<Button variant="outline" size="sm" onclick={() => void todos.refresh()}>Try again</Button>
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
					{@const selected = todos.selected?.as === 'files' && todos.selected.path === row.path}
					{@const open = row.kind === 'directory' && expanded.has(row.path)}
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
											{:else if todoPaths.data?.has(row.path)}
												<ListTodoIcon />
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
								<DropdownMenu.Content class="min-w-44" align="start" onCloseAutoFocus={keepFieldFocus}>
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
						{/if}
					</Sidebar.MenuItem>
					{#if open}{@render createField(row.path, row.depth + 1)}{/if}
				{:else}
					{#if editing === undefined}
						<li>
							<Empty.Root class="p-6">
								<Empty.Title>No files yet</Empty.Title>
								<Empty.Description>Add a todo, or create a file or folder above.</Empty.Description>
							</Empty.Root>
						</li>
					{/if}
				{/each}
			</Sidebar.Menu>
		</nav>
	{/if}
</section>
