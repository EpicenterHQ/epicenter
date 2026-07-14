<script lang="ts">
	import * as Resizable from '@epicenter/ui/resizable';
	import { SidebarProvider } from '@epicenter/ui/sidebar';
	import { honeycrisp } from '$lib/honeycrisp';
	import CommandPalette from './components/CommandPalette.svelte';
	import NoteBodyPane from './components/NoteBodyPane.svelte';
	import NoteList from './components/NoteList.svelte';
	import HoneycripSidebar from './components/Sidebar.svelte';
</script>

<svelte:window
	onkeydown={async (e) => {
		const meta = e.metaKey || e.ctrlKey;
		if (!meta) return;

		if (e.key === 'n' && e.shiftKey) {
			e.preventDefault();
			void honeycrisp.state.folders.create().catch(reportError);
		} else if (e.key === 'n') {
			e.preventDefault();
			try {
				const { id } = await honeycrisp.state.notes.create(
					honeycrisp.state.view.selectedFolderId,
				);
				honeycrisp.state.view.selectNote(id);
			} catch (cause) {
				reportError(cause);
			}
		}
	}}
/>

<SidebarProvider>
	<HoneycripSidebar />

	<main class="flex h-screen flex-1 overflow-hidden">
		<Resizable.PaneGroup direction="horizontal">
			<Resizable.Pane defaultSize={35} minSize={20}>
				<NoteList />
			</Resizable.Pane>
			<Resizable.Handle />
			<Resizable.Pane defaultSize={65} minSize={30} class="flex flex-col">
				{#if honeycrisp.state.view.selectedNote && honeycrisp.state.view.selectedNoteId}
					{#key honeycrisp.state.view.selectedNoteId}
						<NoteBodyPane
							noteId={honeycrisp.state.view.selectedNoteId}
							focusRequest={honeycrisp.state.view.editorFocusRequest}
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
