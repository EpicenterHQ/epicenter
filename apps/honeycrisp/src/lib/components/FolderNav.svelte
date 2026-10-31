<!--
	The folders: search, All Notes, each folder with how many notes name it,
	and the folder files that do not read as folders, to repair. Creating,
	renaming and deleting a folder each write its file alone.
-->
<script lang="ts">
	import { describeIssues } from '@epicenter/definition/contract';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import { Input } from '@epicenter/ui/input';
	import { toast } from '@epicenter/ui/sonner';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { byName, type Folder, folderLabel, folderPath, getHoneycrisp } from '$lib/honeycrisp.svelte.js';

	const app = getHoneycrisp();
	const { notes, folders } = app;

	const counts = $derived.by(() => {
		const byFolder = new Map<string, number>();
		for (const { folderId } of notes.items)
			if (folderId !== undefined) byFolder.set(folderId, (byFolder.get(folderId) ?? 0) + 1);
		return byFolder;
	});

	/** The folder being named: a new one, or an existing one by id. */
	let naming = $state<{ id: string | undefined; value: string } | undefined>();
	let savingName = false;

	async function commitName() {
		if (savingName) return;
		const current = naming;
		const name = current?.value.trim();
		if (!current || !name) {
			naming = undefined;
			return;
		}
		const target = folders.items.find((folder) => folder.id === current.id);
		savingName = true;
		const saved =
			target === undefined
				? await app.createFolder(name)
				: name === target.name
					? undefined
					: await folders.update({ id: target.id }, { name });
		savingName = false;
		if (saved?.error) {
			toast.error('Could not save the folder', { description: saved.error.message });
			return;
		}
		if (naming === current && current.value.trim() === name) naming = undefined;
	}

	function confirmDelete(folder: Folder) {
		confirmationDialog.open({
			title: `Delete the folder “${folderLabel(folder)}”?`,
			description: `This deletes ${folderPath(folder.id)}. Its notes are kept, in All Notes.`,
			confirm: { text: 'Delete', variant: 'destructive' },
			async onConfirm() {
				const { error } = await app.deleteFolder(folder.id);
				if (error !== null) toast.error('Could not delete the folder', { description: error.message });
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
		value={app.filter.query}
		oninput={(event) => app.setQuery(event.currentTarget.value)}
	/>
	<button
		class={row}
		class:bg-accent={app.filter.folderId === null}
		aria-current={app.filter.folderId === null ? 'true' : undefined}
		onclick={() => app.showFolder(null)}
	>
		<FileTextIcon class="size-4" />
		<span>All Notes</span>
		<span class="ml-auto text-xs text-muted-foreground">{notes.items.length}</span>
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
	{#each folders.items.toSorted(byName) as folder (folder.id)}
		{#if naming?.id === folder.id}
			{@render nameInput()}
		{:else}
			<div class="group flex items-center" data-folder={folder.id}>
				<button
					class={row}
					class:bg-accent={app.filter.folderId === folder.id}
					aria-current={app.filter.folderId === folder.id ? 'true' : undefined}
					onclick={() => app.showFolder(folder.id)}
				>
					{#if folder.icon}
						<span class="text-base leading-none">{folder.icon}</span>
					{:else}
						<FolderIcon class="size-4" />
					{/if}
					<span class="truncate">{folderLabel(folder)}</span>
					<span class="ml-auto text-xs text-muted-foreground">{counts.get(folder.id) ?? 0}</span>
				</button>
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button {...props} variant="ghost" size="icon-sm" aria-label="Actions for {folderLabel(folder)}">
								<EllipsisIcon />
							</Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="start" class="w-40">
						<DropdownMenu.Item onSelect={() => (naming = { id: folder.id, value: folder.name })}>
							Rename
						</DropdownMenu.Item>
						<DropdownMenu.Separator />
						<DropdownMenu.Item variant="destructive" onSelect={() => confirmDelete(folder)}>
							Delete…
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			</div>
		{/if}
	{:else}
		{#if !naming && !folders.loading}<p class="px-2 py-1 text-xs text-muted-foreground">No folders yet</p>{/if}
	{/each}

	{#if folders.invalid.length > 0}
		<!-- Folder files that do not read as folders: each opens with its text, to repair or delete. -->
		<h3 class="mt-2 px-2 text-xs font-medium text-destructive">Folders that need repair</h3>
		{#each folders.invalid as file (file.id)}
			<button
				class="{row} h-auto flex-col items-start gap-0.5 py-1.5"
				class:bg-accent={app.selected?.collection === 'folders' && app.selected.id === file.id}
				data-invalid-folder={file.id}
				onclick={() => app.open({ collection: 'folders', id: file.id })}
			>
				<span class="font-mono text-xs">{file.path}</span>
				<span class="line-clamp-2 text-xs text-muted-foreground">
					{file.text === null ? 'It is not text.' : describeIssues(file.issues)}
				</span>
			</button>
		{/each}
	{/if}
</nav>
