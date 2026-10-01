<script lang="ts">
	import { createNote } from '$lib/notes.js';
	import type { ReactiveData } from '@epicenter/svelte';
	import type { HoneycrispData } from '$lib/data.js';
	import {
		CommandPalette as UiCommandPalette,
		type CommandPaletteItem,
	} from '@epicenter/ui/command-palette';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import FolderPlusIcon from '@lucide/svelte/icons/folder-plus';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { navigation } from '$lib/navigation.svelte.js';


	let props: { data: ReactiveData<HoneycrispData> } = $props();

	let isOpen = $state(false);

	const items = $derived.by((): CommandPaletteItem[] => [
		{
			id: 'folder:all',
			label: 'All Notes',
			group: 'Folders',
			icon: FileTextIcon,
			onSelect: () => navigation.selectFolder(null),
		},
		...props.data.tables.folders.rows.toSorted((a, b) => a.name.localeCompare(b.name)).map((folder): CommandPaletteItem => ({
			id: `folder:${folder.id}`,
			label: folder.icon ? `${folder.icon} ${folder.name}` : folder.name,
			keywords: [folder.name],
			group: 'Folders',
			icon: folder.icon ? undefined : FolderIcon,
			onSelect: () => navigation.selectFolder(folder.id),
		})),
		...props.data.tables.notes.rows.filter((note) => note.deletedAt === null).map((note): CommandPaletteItem => ({
			id: `note:${note.id}`,
			label: note.title || 'Untitled',
			group: 'Notes',
			icon: FileTextIcon,
			onSelect: () => navigation.selectNote(note.id),
		})),
		{
			id: 'action:new-note',
			label: 'New Note',
			group: 'Actions',
			icon: PlusIcon,
			onSelect: () =>
				createNote(props.data),
		},
		{
			id: 'action:new-folder',
			label: 'New Folder',
			group: 'Actions',
			icon: FolderPlusIcon,
			onSelect: () =>
				props.data.tables.folders.create({ name: 'New Folder', icon: null }),
		},
	]);
</script>

<UiCommandPalette
	{items}
	bind:open={isOpen}
	placeholder="Search notes..."
	emptyMessage="No results found."
	title="Search Notes"
	description="Search folders, notes, and actions"
/>
