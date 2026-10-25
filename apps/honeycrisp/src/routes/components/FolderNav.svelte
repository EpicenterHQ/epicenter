<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import { Input } from '@epicenter/ui/input';
	import { toast } from '@epicenter/ui/sonner';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { FOLDERS, type FolderEntry, folderLabel as nameOf, rowFile } from '$lib/data.js';
	import { actionMessage, foldersOf, type Notes, notesOf } from '$lib/notes.svelte.js';

	let { notes }: { notes: Notes } = $props();

	const noteRows = $derived(notesOf(notes.folder.tables.notes.rows));
	const folders = $derived(
		foldersOf(notes.folder.tables.folders.rows).toSorted((a, b) => nameOf(a).localeCompare(nameOf(b))),
	);
	const counts = $derived.by(() => {
		const result = { active: 0, deleted: 0, folders: new Map<string, number>() };
		for (const note of noteRows) {
			const fields = note.fields;
			if (typeof fields.deletedAt === 'string') {
				result.deleted += 1;
				continue;
			}
			result.active += 1;
			const id = fields.folderId;
			if (typeof id === 'string') result.folders.set(id, (result.folders.get(id) ?? 0) + 1);
		}
		return result;
	});

	/** The folder being named: a new one, or an existing one by id. */
	let naming = $state<{ id: string | undefined; value: string } | undefined>();

	async function commitName() {
		const current = naming;
		naming = undefined;
		const name = current?.value.trim();
		if (!current || !name) return;
		const target = folders.find((folder) => folder.id === current.id);
		const problem =
			target === undefined
				? await notes.createFolder(name)
				: name === nameOf(target)
					? undefined
					: await notes.patchFolder(rowFile(FOLDERS, target.id), { name });
		const message = actionMessage(problem);
		if (message) toast.error('Could not save the folder', { description: message });
	}

	function confirmDeleteFolder(folder: FolderEntry) {
		confirmationDialog.open({
			title: `Delete the folder “${nameOf(folder)}”?`,
			description: 'Its notes are kept and moved to All Notes.',
			confirm: { text: 'Delete', variant: 'destructive' },
			async onConfirm() {
				const problem = await notes.deleteFolder(folder);
				const message = actionMessage(problem);
				if (message) toast.error('Could not delete the folder', { description: message });
			},
		});
	}

	const row = 'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent/50';
</script>

{#snippet nameInput()}
	{#if naming}
		<Input
			class="h-8"
			aria-label="Folder name"
			bind:value={naming.value}
			{@attach (node: HTMLInputElement) => {
				node.focus();
				node.select();
			}}
			onkeydown={(event) => {
				if (event.key === 'Enter') void commitName();
				if (event.key === 'Escape') naming = undefined;
			}}
			onblur={() => void commitName()}
		/>
	{/if}
{/snippet}

<nav class="flex h-full min-h-0 flex-col gap-1 overflow-y-auto bg-sidebar p-2 text-sidebar-foreground" aria-label="Folders">
	<Input
		class="mb-1 h-8"
		placeholder="Search notes…"
		aria-label="Search notes"
		value={notes.view.query}
		oninput={(event) => notes.setQuery(event.currentTarget.value)}
	/>
	<button
		class={row}
		class:bg-accent={notes.view.folderId === null && !notes.view.deleted}
		aria-current={notes.view.folderId === null && !notes.view.deleted ? 'true' : undefined}
		onclick={() => notes.showFolder(null)}
	>
		<FileTextIcon class="size-4" />
		<span>All Notes</span>
		<span class="ml-auto text-xs text-muted-foreground">{counts.active}</span>
	</button>
	<button
		class={row}
		class:bg-accent={notes.view.deleted}
		aria-current={notes.view.deleted ? 'true' : undefined}
		onclick={() => notes.showDeleted()}
	>
		<TrashIcon class="size-4" />
		<span>Recently Deleted</span>
		{#if counts.deleted > 0}<span class="ml-auto text-xs text-muted-foreground">{counts.deleted}</span>{/if}
	</button>

	<div class="mt-2 flex items-center justify-between px-2">
		<h2 class="text-xs font-medium text-muted-foreground">Folders</h2>
		<Button
			variant="ghost"
			size="icon-sm"
			aria-label="New folder"
			tooltip="New folder"
			onclick={() => (naming = { id: undefined, value: 'New Folder' })}
		>
			<PlusIcon />
		</Button>
	</div>
	{#if naming && naming.id === undefined}{@render nameInput()}{/if}
	{#each folders as folder (folder.id)}
		{#if naming?.id === folder.id}
			{@render nameInput()}
		{:else}
			<div class="group flex items-center">
				<button
					class={row}
					class:bg-accent={notes.view.folderId === folder.id && !notes.view.deleted}
					aria-current={notes.view.folderId === folder.id && !notes.view.deleted ? 'true' : undefined}
					onclick={() => notes.showFolder(folder.id)}
				>
					{#if folder.fields.icon}
						<span class="text-base leading-none">{folder.fields.icon}</span>
					{:else}
						<FolderIcon class="size-4" />
					{/if}
					<span class="truncate">{nameOf(folder)}</span>
					<span class="ml-auto text-xs text-muted-foreground">{counts.folders.get(folder.id) ?? 0}</span>
				</button>
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button {...props} variant="ghost" size="icon-sm" aria-label="Actions for {nameOf(folder)}">
								<EllipsisIcon />
							</Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="start" class="w-40">
						<DropdownMenu.Item
							onSelect={() => (naming = { id: folder.id, value: nameOf(folder) })}
						>
							Rename
						</DropdownMenu.Item>
						<DropdownMenu.Item onSelect={() => notes.open(rowFile(FOLDERS, folder.id), 'text')}>
							Open file
						</DropdownMenu.Item>
						<DropdownMenu.Separator />
						<DropdownMenu.Item variant="destructive" onSelect={() => confirmDeleteFolder(folder)}>
							Delete…
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			</div>
		{/if}
	{:else}
		{#if !naming}<p class="px-2 py-1 text-xs text-muted-foreground">No folders yet</p>{/if}
	{/each}
</nav>
