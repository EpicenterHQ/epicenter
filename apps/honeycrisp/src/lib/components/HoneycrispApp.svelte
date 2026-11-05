<!--
	Honeycrisp over the folder's notes and folders (`$lib/app`), in either
	build: the header, the folders, the notes, and what is open, which it
	sets for every component under it (`setHoneycrisp`).
-->
<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import * as Resizable from '@epicenter/ui/resizable';
	import { folder } from '$lib/app.js';
	import { createHoneycrisp, setHoneycrisp } from '$lib/honeycrisp.svelte.js';
	import AppHeader from './AppHeader.svelte';
	import FolderNav from './FolderNav.svelte';
	import FolderRepair from './FolderRepair.svelte';
	import NoteDetail from './NoteDetail.svelte';
	import NoteList from './NoteList.svelte';

	const app = setHoneycrisp(createHoneycrisp({ notes: folder.notes, folders: folder.folders }));

	const createNote = () => void app.createNote();
</script>

<svelte:window
	onkeydown={(event) => {
		const mod = event.metaKey || event.ctrlKey;
		if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'n') {
			event.preventDefault();
			createNote();
		}
	}}
/>

<div class="flex h-dvh flex-col overflow-hidden">
	<AppHeader />

	<Resizable.PaneGroup direction="horizontal" class="min-h-0 flex-1">
		<Resizable.Pane id="folders" order={1} defaultSize={18} minSize={10} maxSize={30}>
			<FolderNav />
		</Resizable.Pane>
		<Resizable.Handle />
		<Resizable.Pane id="list" order={2} defaultSize={26} minSize={15}>
			<NoteList onCreate={createNote} />
		</Resizable.Pane>
		<Resizable.Handle />
		<Resizable.Pane id="detail" order={3} defaultSize={56} minSize={30}>
			{@const shown = app.selected}
			{#if shown === undefined}
				<Empty.Root class="h-full">
					<Empty.Title>No note selected</Empty.Title>
					<Empty.Description>Choose a note from the list, or press ⌘N to create one.</Empty.Description>
				</Empty.Root>
			{:else}
				<!-- A new selection is a new view: its editors and their undo history belong to one note. -->
				{#key `${shown.collection}/${shown.id}`}
					{#if shown.collection === 'notes'}
						<NoteDetail id={shown.id} />
					{:else}
						<FolderRepair id={shown.id} />
					{/if}
				{/key}
			{/if}
		</Resizable.Pane>
	</Resizable.PaneGroup>
</div>
