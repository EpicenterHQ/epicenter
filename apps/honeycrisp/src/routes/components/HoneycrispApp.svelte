<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { type NotesFolder, setFolder } from '$lib/folder.js';
	import * as Resizable from '@epicenter/ui/resizable';
	import { toast } from '@epicenter/ui/sonner';
	import { createNotes } from '$lib/notes.svelte.js';
	import AppHeader from './AppHeader.svelte';
	import FileBrowser from './FileBrowser.svelte';
	import FileDetail from './FileDetail.svelte';
	import FolderNav from './FolderNav.svelte';
	import NoteList from './NoteList.svelte';

	// The notes over the folder `<OpenFolder>` opened, listed, and wrapped.
	let { folder }: { folder: NotesFolder } = $props();

	// The opened folder stays fixed until this app root unmounts.
	// svelte-ignore state_referenced_locally
	const notes = createNotes(setFolder(folder));

	let filesOpen = $state(false);

</script>

<svelte:window
	onkeydown={async (event) => {
		const mod = event.metaKey || event.ctrlKey;
		if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'b') {
			event.preventDefault();
			filesOpen = !filesOpen;
		} else if (mod && !event.shiftKey && event.key.toLowerCase() === 'n') {
			event.preventDefault();
			const problem = await notes.createNote();
			if (problem) toast.error('Could not create the note', { description: problem });
		}
	}}
/>

<div class="flex h-dvh flex-col overflow-hidden">
	<AppHeader
		{notes}
		{filesOpen}
		onToggleFiles={() => (filesOpen = !filesOpen)}
	/>

	<Resizable.PaneGroup direction="horizontal" class="min-h-0 flex-1">
		<Resizable.Pane id="folders" order={1} defaultSize={16} minSize={10} maxSize={30}>
			<FolderNav {notes} />
		</Resizable.Pane>
		<Resizable.Handle />
		<Resizable.Pane id="list" order={2} defaultSize={24} minSize={15}>
			<NoteList {notes} />
		</Resizable.Pane>
		<Resizable.Handle />
		<Resizable.Pane id="detail" order={3} defaultSize={filesOpen ? 40 : 60} minSize={30}>
			{@const shown = notes.selected}
			{#if shown !== undefined}
				<!-- Changing presentation keeps this file's editors and their undo history alive. -->
				{#key shown.path}
					<FileDetail {notes} path={shown.path} as={shown.as} />
				{/key}
			{:else}
				<Empty.Root class="h-full">
					<Empty.Title>No note selected</Empty.Title>
					<Empty.Description>Choose a note from the list, or press ⌘N to create one.</Empty.Description>
				</Empty.Root>
			{/if}
		</Resizable.Pane>
		{#if filesOpen}
			<Resizable.Handle />
			<Resizable.Pane id="files" order={4} defaultSize={20} minSize={14} maxSize={40}>
				<FileBrowser {notes} />
			</Resizable.Pane>
		{/if}
	</Resizable.PaneGroup>
</div>
