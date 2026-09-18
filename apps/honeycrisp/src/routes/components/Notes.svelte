<script lang="ts">
	import { createNote } from '$lib/notes.js';
	import { PersistenceNotice } from '@epicenter/app-shell/persistence-notice';
	import * as Resizable from '@epicenter/ui/resizable';
	import { SidebarProvider } from '@epicenter/ui/sidebar';
	import { fromData } from '@epicenter/svelte';
	import type { HoneycrispData } from '$lib/data';
	import { navigation } from '$lib/navigation.svelte.js';
	import CommandPalette from './CommandPalette.svelte';
	import NoteBodyPane from './NoteBodyPane.svelte';
	import NoteList from './NoteList.svelte';
	import HoneycrispSidebar from './Sidebar.svelte';

	let props: { data: HoneycrispData } = $props();

	// Each route branch mounts Notes with fixed data. Repeated visits reuse its projection.
	/* svelte-ignore state_referenced_locally */
	const data = fromData(props.data);
</script>

<PersistenceNotice persistence={data.persistence} />

<svelte:window
	onkeydown={(e) => {
		const meta = e.metaKey || e.ctrlKey;
		if (!meta) return;

		if (e.key === 'n' && e.shiftKey) {
			e.preventDefault();
			data.tables.folders.create({ name: 'New Folder', icon: null });
		} else if (e.key === 'n') {
			e.preventDefault();
			createNote(data);
		}
	}}
/>

<SidebarProvider>
	<HoneycrispSidebar {data} />

	<main class="flex h-screen flex-1 overflow-hidden">
		<Resizable.PaneGroup direction="horizontal">
			<Resizable.Pane defaultSize={35} minSize={20}>
				<NoteList {data} />
			</Resizable.Pane>
			<Resizable.Handle />
			<Resizable.Pane defaultSize={65} minSize={30} class="flex flex-col">
				{#if navigation.noteId}
					{#key navigation.noteId}
						<NoteBodyPane
							{data}
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

<CommandPalette {data} />
