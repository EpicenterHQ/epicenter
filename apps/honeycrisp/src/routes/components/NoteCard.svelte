<script lang="ts">
	import { previewOf, deleteNote, permanentlyDeleteNote } from '$lib/notes.js';
	import type { ReactiveData } from '@epicenter/svelte';
	import type { HoneycrispData } from '$lib/data.js';
	import type { Note } from '$lib/data';
	import * as AlertDialog from '@epicenter/ui/alert-dialog';
	import { Button, buttonVariants } from '@epicenter/ui/button';
	import * as ContextMenu from '@epicenter/ui/context-menu';
	import * as Item from '@epicenter/ui/item';
	import { cn } from '@epicenter/ui/utils';
	import ArchiveRestoreIcon from '@lucide/svelte/icons/archive-restore';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import PinIcon from '@lucide/svelte/icons/pin';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { format } from 'date-fns';


	let props: { data: ReactiveData<HoneycrispData>; note: Note; isSelected: boolean; onSelect: () => void } = $props();

	/** Derive deleted status from the note itself, no need to check view mode. */
	const isDeleted = $derived(props.note.deletedAt !== null);

	// Read off this note's node rather than off a stored field, and subscribed
	// to this note's body alone (ADR-0295).
	//
	// The initial id is the right one to capture: `NoteList` keys its `{#each}`
	// by `props.note.id`, so this component is torn down and rebuilt for a different
	// note rather than handed one. Deriving it instead would rebuild the
	// subscription on every commit that touches the row, because the table projection
	// hands out a fresh row object each time.
	// svelte-ignore state_referenced_locally
	const preview = previewOf(props.data, props.note.id);

	let confirmingPermanentDelete = $state(false);
	const folders = $derived(
		props.data.tables.folders.rows.toSorted((a, b) => a.name.localeCompare(b.name)),
	);
</script>

<ContextMenu.Root>
	<ContextMenu.Trigger>
		<Item.Root
			size="sm"
			class={cn(
				'cursor-pointer flex-col items-stretch gap-0.5 rounded-lg py-2 hover:bg-accent/30',
				props.isSelected && 'bg-accent',
			)}
			onclick={props.onSelect}
		>
			<div class="flex items-start justify-between gap-2">
				<span class="font-medium line-clamp-1">
					{#if props.note.pinned}
						<PinIcon class="mr-1 inline size-3 fill-current align-baseline" />
					{/if}
					{props.note.title || 'Untitled'}
				</span>
				<span class="shrink-0 text-xs text-muted-foreground">
					{format(new Date(props.note.updatedAt), 'h:mm a')}
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
						props.isSelected && 'flex',
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
							props.data.tables.notes.update(props.note.id, { deletedAt: null });
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
						props.isSelected && 'flex',
					)}
				>
					<Button
						variant="ghost"
						size="icon"
						class="size-6"
						tooltip={props.note.pinned ? 'Unpin' : 'Pin'}
						aria-label={props.note.pinned ? 'Unpin' : 'Pin'}
						onclick={(e) => {
							e.stopPropagation();
							props.data.tables.notes.update(props.note.id, { pinned: !props.note.pinned });
						}}
					>
						<PinIcon class={cn('size-3', props.note.pinned && 'fill-current')} />
					</Button>
					<Button
						variant="ghost-destructive"
						size="icon"
						class="size-6"
						tooltip="Delete"
						aria-label="Delete"
						onclick={(e) => {
							e.stopPropagation();
							deleteNote(props.data, props.note.id);
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
					props.data.tables.notes.update(props.note.id, { deletedAt: null })}
			>
				<ArchiveRestoreIcon class="mr-2 size-4" />
				Restore
			</ContextMenu.Item>
			<ContextMenu.Separator />
			<ContextMenu.Item
				class="text-destructive focus:text-destructive"
				onclick={() => {
					confirmingPermanentDelete = true;
				}}
			>
				<TrashIcon class="mr-2 size-4" />
				Delete Permanently
			</ContextMenu.Item>
		{:else}
			<ContextMenu.Item
				onclick={() =>
					props.data.tables.notes.update(props.note.id, { pinned: !props.note.pinned })}
			>
				<PinIcon class={cn('mr-2 size-4', props.note.pinned && 'fill-current')} />
				{props.note.pinned ? 'Unpin' : 'Pin'}
			</ContextMenu.Item>
			<ContextMenu.Separator />
			<ContextMenu.Sub>
				<ContextMenu.SubTrigger>
					<FolderIcon class="mr-2 size-4" />
					Move to Folder
				</ContextMenu.SubTrigger>
				<ContextMenu.SubContent class="w-48">
					<ContextMenu.Item
						onclick={() =>
							props.data.tables.notes.update(props.note.id, { folderId: null })}
					>
						<FileTextIcon class="mr-2 size-4" />
						Unfiled
					</ContextMenu.Item>
					<ContextMenu.Separator />
					{#each folders as folder (folder.id)}
						<ContextMenu.Item
							onclick={() =>
								props.data.tables.notes.update(props.note.id, { folderId: folder.id })}
						>
							{#if folder.icon}
								<span class="mr-2 text-base leading-none">{folder.icon}</span>
							{:else}
								<FolderIcon class="mr-2 size-4" />
							{/if}
							{folder.name}
						</ContextMenu.Item>
					{/each}
				</ContextMenu.SubContent>
			</ContextMenu.Sub>
			<ContextMenu.Separator />
			<ContextMenu.Item
				class="text-destructive focus:text-destructive"
				onclick={() =>
					deleteNote(props.data, props.note.id)}
			>
				<TrashIcon class="mr-2 size-4" />
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
				class={buttonVariants({ variant: 'destructive' })}
				onclick={() =>
					permanentlyDeleteNote(props.data, props.note.id)}
				>Delete</AlertDialog.Action
			>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
