<script lang="ts">
	import type { Note } from '$lib/data';
	import * as AlertDialog from '@epicenter/ui/alert-dialog';
	import { Button } from '@epicenter/ui/button';
	import * as ContextMenu from '@epicenter/ui/context-menu';
	import * as Item from '@epicenter/ui/item';
	import { cn } from '@epicenter/ui/utils';
	import ArchiveRestoreIcon from '@lucide/svelte/icons/archive-restore';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import PinIcon from '@lucide/svelte/icons/pin';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { format } from 'date-fns';
	import { getHoneycrisp } from '$lib/app.svelte.js';

	const honeycrisp = getHoneycrisp();

	let {
		note,
		isSelected,
		onSelect,
	}: {
		note: Note;
		isSelected: boolean;
		onSelect: () => void;
	} = $props();

	/** Derive deleted status from the note itself, no need to check view mode. */
	const isDeleted = $derived(note.deletedAt !== null);

	// Read off this note's node rather than off a stored field, and subscribed
	// to this note's body alone (ADR-0295).
	//
	// The initial id is the right one to capture: `NoteList` keys its `{#each}`
	// by `note.id`, so this component is torn down and rebuilt for a different
	// note rather than handed one. Deriving it instead would rebuild the
	// subscription on every commit that touches the row, because `notes.all`
	// hands out a fresh object each time.
	// svelte-ignore state_referenced_locally
	const preview = honeycrisp.tables.notes.previewOf(note.id);

	let confirmingPermanentDelete = $state(false);
</script>

<ContextMenu.Root>
	<ContextMenu.Trigger>
		<Item.Root
			size="sm"
			class={cn(
				'cursor-pointer flex-col items-stretch gap-0.5 rounded-lg py-2 hover:bg-accent/30',
				isSelected && 'bg-accent',
			)}
			onclick={onSelect}
		>
			<div class="flex items-start justify-between gap-2">
				<span class="font-medium line-clamp-1">
					{#if note.pinned}
						<PinIcon class="mr-1 inline size-3 fill-current align-baseline" />
					{/if}
					{note.title || 'Untitled'}
				</span>
				<span class="shrink-0 text-xs text-muted-foreground">
					{format(new Date(note.updatedAt), 'h:mm a')}
				</span>
			</div>
			<Item.Description class="text-xs">
				{preview.current || 'No content'}
			</Item.Description>

			{#if isDeleted}
				<div
					class={cn(
						'absolute bottom-1 right-2 hidden items-center gap-0.5 group-hover/item:flex',
						// `cn` merges this against `hidden` rather than stacking both and
						// letting stylesheet order decide which display wins.
						isSelected && 'flex',
					)}
				>
					<Button
						variant="ghost"
						size="icon"
						class="size-6"
						tooltip="Restore"
						aria-label="Restore"
						onclick={(e) => {
							e.stopPropagation();
							honeycrisp.tables.notes.restore(note.id);
						}}
					>
						<ArchiveRestoreIcon class="size-3" />
					</Button>
					<Button
						variant="ghost-destructive"
						size="icon"
						class="size-6"
						tooltip="Delete permanently"
						aria-label="Delete permanently"
						onclick={(e) => {
							e.stopPropagation();
							confirmingPermanentDelete = true;
						}}
					>
						<TrashIcon class="size-3" />
					</Button>
				</div>
			{:else}
				<div
					class={cn(
						'absolute bottom-1 right-2 hidden items-center gap-0.5 group-hover/item:flex',
						// `cn` merges this against `hidden` rather than stacking both and
						// letting stylesheet order decide which display wins.
						isSelected && 'flex',
					)}
				>
					<Button
						variant="ghost"
						size="icon"
						class="size-6"
						tooltip={note.pinned ? 'Unpin' : 'Pin'}
						aria-label={note.pinned ? 'Unpin' : 'Pin'}
						onclick={(e) => {
							e.stopPropagation();
							honeycrisp.tables.notes.togglePin(note.id);
						}}
					>
						<PinIcon class={cn('size-3', note.pinned && 'fill-current')} />
					</Button>
					<Button
						variant="ghost-destructive"
						size="icon"
						class="size-6"
						tooltip="Delete"
						aria-label="Delete"
						onclick={(e) => {
							e.stopPropagation();
							honeycrisp.tables.notes.softDelete(note.id);
						}}
					>
						<TrashIcon class="size-3" />
					</Button>
				</div>
			{/if}
		</Item.Root>
	</ContextMenu.Trigger>

	<ContextMenu.Content class="w-48">
		{#if isDeleted}
			<ContextMenu.Item
				onclick={() =>
					honeycrisp.tables.notes.restore(note.id)}
			>
				<ArchiveRestoreIcon class="size-4" />
				Restore
			</ContextMenu.Item>
			<ContextMenu.Separator />
			<ContextMenu.Item
				variant="destructive"
				onclick={() => {
					confirmingPermanentDelete = true;
				}}
			>
				<TrashIcon class="size-4" />
				Delete Permanently
			</ContextMenu.Item>
		{:else}
			<ContextMenu.Item
				onclick={() =>
					honeycrisp.tables.notes.togglePin(note.id)}
			>
				<PinIcon class={cn('size-4', note.pinned && 'fill-current')} />
				{note.pinned ? 'Unpin' : 'Pin'}
			</ContextMenu.Item>
			<ContextMenu.Separator />
			<ContextMenu.Sub>
				<ContextMenu.SubTrigger>
					<FolderIcon class="size-4" />
					Move to Folder
				</ContextMenu.SubTrigger>
				<ContextMenu.SubContent class="w-48 max-h-(--bits-menu-content-available-height) overflow-y-auto">
					<ContextMenu.Item
						onclick={() =>
							honeycrisp.tables.notes.moveToFolder(note.id, null)}
					>
						<FileTextIcon class="size-4" />
						Unfiled
					</ContextMenu.Item>
					<ContextMenu.Separator />
					{#each honeycrisp.tables.folders.all as folder (folder.id)}
						<ContextMenu.Item
							onclick={() =>
								honeycrisp.tables.notes.moveToFolder(note.id, folder.id)}
						>
							{#if folder.icon}
								<span class="text-base leading-none">{folder.icon}</span>
							{:else}
								<FolderIcon class="size-4" />
							{/if}
							{folder.name}
						</ContextMenu.Item>
					{/each}
				</ContextMenu.SubContent>
			</ContextMenu.Sub>
			<ContextMenu.Separator />
			<ContextMenu.Item
				variant="destructive"
				onclick={() =>
					honeycrisp.tables.notes.softDelete(note.id)}
			>
				<TrashIcon class="size-4" />
				Delete
			</ContextMenu.Item>
		{/if}
	</ContextMenu.Content>
</ContextMenu.Root>

<AlertDialog.Root bind:open={confirmingPermanentDelete}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete Permanently?</AlertDialog.Title>
			<AlertDialog.Description>
				This note will be permanently deleted. This action cannot be undone.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				variant="destructive"
				onclick={() =>
					honeycrisp.tables.notes.permanentlyDelete(note.id)}
				>Delete</AlertDialog.Action
			>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
