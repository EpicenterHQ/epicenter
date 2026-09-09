<script lang="ts">
	import type { Snippet } from 'svelte';
	import { PersistenceNotice } from '@epicenter/app-shell/persistence-notice';
	import * as Resizable from '@epicenter/ui/resizable';
	import { SidebarProvider } from '@epicenter/ui/sidebar';
	import { fromData } from '@epicenter/svelte';
	import { createHoneycrisp, setHoneycrisp } from '$lib/app.svelte.js';
	import type { HoneycrispData } from '$lib/data';
	import { navigation } from '$lib/navigation.svelte.js';
	import CommandPalette from './CommandPalette.svelte';
	import NoteBodyPane from './NoteBodyPane.svelte';
	import NoteList from './NoteList.svelte';
	import HoneycrispSidebar from './Sidebar.svelte';

	// The opened store, raw, and everything a sidebar shows about it is read off
	// it. The route used to hand four props down, assembled by the opener it
	// owned; the store states its own address and its own connection now
	// (ADR-0340). `fromData` runs here rather than above, because this component
	// mounts exactly once per opened store and the adaptation is per store.
	let {
		data: opened,
		removeLocalData,
		librarySelection,
	}: { data: HoneycrispData; librarySelection: Snippet; removeLocalData?: () => Promise<void> } = $props();

	/* svelte-ignore state_referenced_locally */
	const data = fromData(opened);

	// The application object is provided here rather than by a component whose
	// whole body was this line. `setContext` must run during initialisation, and
	// this component only mounts under `ready`, which is what carries "the store
	// is open" to every descendant without a type saying so.
	// Read once, not `$derived`: the route mounts this exactly once per opened
	// store, so `data` never changes while this component lives.
	/* svelte-ignore state_referenced_locally */
	const honeycrisp = setHoneycrisp(createHoneycrisp({ data }));

	// Passed through whole. A refusal is data on the status now, and the sidebar
	// is what decides which refusals a person can act on and which ones render
	// as nothing.
	const syncStatus = () => data.sync.status();
</script>

<PersistenceNotice persistence={data.persistence} />

<svelte:window
	onkeydown={(e) => {
		const meta = e.metaKey || e.ctrlKey;
		if (!meta) return;

		if (e.key === 'n' && e.shiftKey) {
			e.preventDefault();
			honeycrisp.tables.folders.create();
		} else if (e.key === 'n') {
			e.preventDefault();
			honeycrisp.createNote();
		}
	}}
/>

<SidebarProvider>
	<HoneycrispSidebar {librarySelection} {syncStatus} folder={undefined} {removeLocalData} />

	<main class="flex h-screen flex-1 overflow-hidden">
		<Resizable.PaneGroup direction="horizontal">
			<Resizable.Pane defaultSize={35} minSize={20}>
				<NoteList hasFolder={false} />
			</Resizable.Pane>
			<Resizable.Handle />
			<Resizable.Pane defaultSize={65} minSize={30} class="flex flex-col">
				{#if navigation.noteId}
					{#key navigation.noteId}
						<NoteBodyPane
							noteId={navigation.noteId}
							focusRequest={navigation.editorFocusRequest}
						/>
					{/key}
				{:else}
					<div class="flex h-full flex-col items-center justify-center gap-2">
						<p class="text-muted-foreground">No note selected</p>
						<p class="text-sm text-muted-foreground/60">
							Choose a note from the list or press ⌘N to create one
						</p>
					</div>
				{/if}
			</Resizable.Pane>
		</Resizable.PaneGroup>
	</main>
</SidebarProvider>

<CommandPalette />
