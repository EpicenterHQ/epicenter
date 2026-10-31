<!--
	Honeycrisp: the header, the folders, the notes, and what is open, over
	this browser's notes and folders and, signed in (under the signed-in
	boundary), the repository's as one list each. Views read and write only
	through the state in context, so none knows which side a note is on.
-->
<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import * as Resizable from '@epicenter/ui/resizable';
	import { toast } from '@epicenter/ui/sonner';
	import { fromClient, oneList } from '@epicenter/svelte/client';
	import { getRepo } from '@epicenter/svelte/repo';
	import type { Honeycrisp } from '$lib/contract.js';
	import { device } from '$lib/device.js';
	import { createHoneycrisp, type Lists, setHoneycrisp } from '$lib/honeycrisp.svelte.js';
	import AppHeader from './AppHeader.svelte';
	import FolderNav from './FolderNav.svelte';
	import FolderRepair from './FolderRepair.svelte';
	import NoteDetail from './NoteDetail.svelte';
	import NoteList from './NoteList.svelte';

	/** Whether this renders under the signed-in boundary, which has the repository. */
	let { signedIn }: { signedIn: boolean } = $props();

	// The lists stay fixed until this app root unmounts.
	const files = fromClient(device);
	// svelte-ignore state_referenced_locally
	const repo = signedIn ? fromClient(getRepo<Honeycrisp>()) : null;
	const lists: Lists =
		repo === null
			? files
			: { notes: oneList(files.notes, repo.notes), folders: oneList(files.folders, repo.folders) };
	const app = setHoneycrisp(createHoneycrisp(lists));

	async function createNote() {
		const { error } = await app.createNote();
		if (error !== null) toast.error('Could not create the note', { description: error.message });
	}
</script>

<svelte:window
	onkeydown={(event) => {
		const mod = event.metaKey || event.ctrlKey;
		if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'n') {
			event.preventDefault();
			void createNote();
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
			<NoteList onCreate={() => void createNote()} />
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
