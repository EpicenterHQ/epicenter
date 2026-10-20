<script lang="ts">
	import { setQueryClientContext } from '@tanstack/svelte-query';
	import * as Empty from '@epicenter/ui/empty';
	import { type getFolder, setFolder } from '$lib/folder.js';
	import { Loading } from '@epicenter/ui/loading';
	import * as Resizable from '@epicenter/ui/resizable';
	import { toast } from '@epicenter/ui/sonner';
	import { beforeNavigate } from '$app/navigation';
	import { createNotes } from '$lib/notes.svelte.js';
	import AppHeader from './AppHeader.svelte';
	import FileBrowser from './FileBrowser.svelte';
	import FileView from './FileView.svelte';
	import FolderNav from './FolderNav.svelte';
	import NoteDetail from './NoteDetail.svelte';
	import NoteList from './NoteList.svelte';

	// The notes over the folder `<FolderApp>` opened. The note and
	// folder rows are read before the views show, so none starts empty.
	let { context }: { context: ReturnType<typeof getFolder> } = $props();

	// The opened context stays fixed until this app root unmounts.
	// svelte-ignore state_referenced_locally
	setFolder(context);
	// svelte-ignore state_referenced_locally
	setQueryClientContext(context.queryClient);
	// svelte-ignore state_referenced_locally
	const notes = createNotes(context);
	const loading = notes.load();

	let filesOpen = $state(false);

	// An accepted Folder change still saving holds reload and navigation.
	// <FolderApp> owns the browser unload prompt. Once the notes are closing,
	// `notes.fenced` holds back every input and action here.
	beforeNavigate(({ cancel }) => {
		if (context.getStatus().saving || context.getStatus().unsaved.length > 0) cancel();
	});
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


{#await loading}
<Loading class="h-dvh" label="Reading your notes…" />
{:then}
<!-- Once the notes are closing nothing here takes input. The editors stay
     mounted while the last saves land. -->
<div class="flex h-dvh flex-col overflow-hidden" inert={notes.fenced}>
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
			{#if shown?.as === 'note'}
				<!-- One mount per opening, so the rich-text undo history lasts while the note is open. -->
				{#key shown.id}
					<NoteDetail {notes} path={shown.path} />
				{/key}
			{:else if shown !== undefined}
				{#key shown.id}
					<FileView {notes} path={shown.path} />
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
{/await}
