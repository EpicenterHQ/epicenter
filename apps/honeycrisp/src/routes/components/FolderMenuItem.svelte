<script lang="ts">
	import type { ReactiveData } from '@epicenter/svelte';
	import type { HoneycrispData } from '$lib/data.js';
	import { deleteHoneycrispFolder, type Folder } from '$lib/data';
	import * as AlertDialog from '@epicenter/ui/alert-dialog';
	import { Button, buttonVariants } from '@epicenter/ui/button';
	import * as Dialog from '@epicenter/ui/dialog';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as EmojiPicker from '@epicenter/ui/emoji-picker';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import SmilePlusIcon from '@lucide/svelte/icons/smile-plus';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { navigation } from '$lib/navigation.svelte.js';


	let props: { data: ReactiveData<HoneycrispData>; folder: Folder; count: number } = $props();

	// ─── Rename State ────────────────────────────────────────────────────

	let isEditing = $state(false);
	let editingName = $state('');

	function commitRename() {
		if (editingName.trim()) {
			props.data.tables.folders.update(props.folder.id, { name: editingName.trim() });
		}
		isEditing = false;
		editingName = '';
	}

	// ─── Icon ────────────────────────────────────────────────────────────

	// A dialog rather than a popover, and that is the component's size talking
	// rather than ceremony: a search field over a scrolling grid of every emoji
	// is a focused task, and the menu that would have anchored a popover closes
	// on select. Picking one commits and closes, so the whole interaction is two
	// clicks.
	let isPickingIcon = $state(false);

	function setIcon(icon: string | null) {
		props.data.tables.folders.update(props.folder.id, { icon });
		isPickingIcon = false;
	}

	// ─── Delete Confirmation ─────────────────────────────────────────────

	let confirmingDelete = $state(false);
</script>

<Sidebar.MenuItem>
	{#if isEditing}
		<div class="flex items-center gap-2 px-2 py-1">
			<!-- svelte-ignore a11y_autofocus -->
			<input
				class="flex-1 rounded border bg-background px-1 py-0.5 text-sm outline-none focus:ring-1 focus:ring-ring"
				bind:value={editingName}
				onkeydown={(e) => {
				if (e.key === 'Enter') commitRename();
				if (e.key === 'Escape') {
					isEditing = false;
					editingName = '';
				}
				}}
				onblur={commitRename}
				autofocus
			>
		</div>
	{:else}
		<Sidebar.MenuButton
			isActive={navigation.folderId === props.folder.id}
			onclick={() => navigation.selectFolder(props.folder.id)}
		>
			{#if props.folder.icon}
				<span class="text-base leading-none">{props.folder.icon}</span>
			{:else}
				<FolderIcon class="size-4" />
			{/if}
			<span>{props.folder.name}</span>
			<span class="ml-auto text-xs text-muted-foreground">
				{props.count}
			</span>
		</Sidebar.MenuButton>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Sidebar.MenuAction showOnHover {...props}>
						<EllipsisIcon class="size-4" />
						<span class="sr-only">Folder actions</span>
					</Sidebar.MenuAction>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="start" side="right" class="w-40">
				<DropdownMenu.Item
					onclick={() => {
					isEditing = true;
					editingName = props.folder.name;
				}}
				>
					<PencilIcon class="mr-2 size-4" />
					Rename
				</DropdownMenu.Item>
				<DropdownMenu.Item onclick={() => (isPickingIcon = true)}>
					{#if props.folder.icon}
						<span class="mr-2 text-base leading-none">{props.folder.icon}</span>
					{:else}
						<SmilePlusIcon class="mr-2 size-4" />
					{/if}
					{props.folder.icon ? 'Change icon' : 'Add icon'}
				</DropdownMenu.Item>
				<DropdownMenu.Separator />
				<DropdownMenu.Item
					class="text-destructive focus:text-destructive"
					onclick={() => (confirmingDelete = true)}
				>
					<TrashIcon class="mr-2 size-4" />
					Delete
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	{/if}
</Sidebar.MenuItem>

<Dialog.Root bind:open={isPickingIcon}>
	<Dialog.Content class="w-auto max-w-fit gap-3 p-3">
		<Dialog.Header class="px-1 text-left">
			<Dialog.Title class="text-sm">Folder icon</Dialog.Title>
			<Dialog.Description class="text-xs">
				Pick an emoji for {props.folder.name}.
			</Dialog.Description>
		</Dialog.Header>

		<!-- Root, then Viewport holding Search, List and Footer: Viewport is the
		     bordered frame the three parts sit inside, so composing them as its
		     siblings leaves the search field floating outside the box.
		     One native emoji string is what the row stores, so `emoji` goes
		     straight through. Recents are device-local and keyed per app, not per
		     folder: the point is the handful of emoji this person reaches for. -->
		<EmojiPicker.Root
			showRecents
			recentsKey="honeycrisp.folder-icon.recents"
			onSelect={({ emoji }) => setIcon(emoji)}
		>
			<EmojiPicker.Viewport>
				<EmojiPicker.Search placeholder="Search emoji" />
				<EmojiPicker.List emptyMessage="No emoji found." />
				<EmojiPicker.Footer>
					{#snippet children({ active })}
						<div class="flex items-center gap-2">
							<EmojiPicker.SkinToneSelector />
							{#if active}
								<span class="text-base leading-none">{active.emoji}</span>
								<span class="truncate text-xs text-muted-foreground">
									{active.data.name}
								</span>
							{:else}
								<span class="text-xs text-muted-foreground">
									Select an emoji
								</span>
							{/if}
						</div>
					{/snippet}
				</EmojiPicker.Footer>
			</EmojiPicker.Viewport>
		</EmojiPicker.Root>

		{#if props.folder.icon}
			<Button
				variant="ghost"
				size="sm"
				class="w-full justify-start text-muted-foreground"
				onclick={() => setIcon(null)}
			>
				<TrashIcon class="mr-2 size-3.5" />
				Remove icon
			</Button>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<AlertDialog.Root bind:open={confirmingDelete}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete Folder?</AlertDialog.Title>
			<AlertDialog.Description>
				Notes in this folder will be moved to All Notes.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				class={buttonVariants({ variant: 'destructive' })}
				onclick={() => {
					deleteHoneycrispFolder(props.data, props.folder.id);
					navigation.folderRemoved(props.folder.id);
				}}
			>
				Delete
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
