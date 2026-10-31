<!--
	Honeycrisp itself, in either variant: the header, the folders, the notes,
	and what is open, over one store's notes and folders, this browser's or
	the repository's. Components read and write only through the state in
	context.
-->
<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import * as Resizable from '@epicenter/ui/resizable';
	import { toast } from '@epicenter/ui/sonner';
	import type { ReactiveClient } from '@epicenter/svelte/client';
	import type { Honeycrisp } from '$lib/contract.js';
	import { createHoneycrisp, setHoneycrisp, type Variant } from '$lib/honeycrisp.svelte.js';
	import AppHeader from './AppHeader.svelte';
	import FolderNav from './FolderNav.svelte';
	import FolderRepair from './FolderRepair.svelte';
	import NoteDetail from './NoteDetail.svelte';
	import NoteList from './NoteList.svelte';

	let {
		variant,
		client,
	}: {
		/** Which variant this page is: this browser's notes and folders, or the repository's. */
		variant: Variant;
		/** Its store's client, which every component under it reads and edits. */
		client: ReactiveClient<Honeycrisp>;
	} = $props();

	// A page shows one client's notes and folders for its life.
	// svelte-ignore state_referenced_locally
	const app = setHoneycrisp(createHoneycrisp(client));

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
	<AppHeader {variant} />

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
