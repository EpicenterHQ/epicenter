<script lang="ts">
	import * as Resizable from '@epicenter/ui/resizable';
	import * as Sheet from '@epicenter/ui/sheet';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { setQueryClientContext } from '@tanstack/svelte-query';
	import type { Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { beforeNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { type Session, setSession } from '$lib/session.svelte.js';
	import AppHeader from './AppHeader.svelte';
	import BottomNav from './BottomNav.svelte';
	import FileBrowser from './FileBrowser.svelte';
	import VerticalNav from './VerticalNav.svelte';
	import { reportWriteNotice } from './file-actions.js';

	/**
	 * The frame every page sits in: navigation, the header with status and
	 * tools, and the file browser. It mounts once with the session and stays
	 * while pages change inside it.
	 */
	let { session, children }: { session: Session; children: Snippet } = $props();

	// One session per mounted layout: the layout opens it once and never swaps it.
	// svelte-ignore state_referenced_locally
	const { library, view } = session;
	// svelte-ignore state_referenced_locally
	setSession(session);
	// The pages read the folder through the session's one cache.
	setQueryClientContext(library.queryClient);

	// A save of a file's text that failed is told, with the text to copy.
	$effect(() => library.onWriteNotice(reportWriteNotice));

	// Edits not yet saved live only in this window until they land.
	// Moving between this app's pages keeps them, so that is never held back.
	// Leaving the document is: in a browser tab the cancel becomes the
	// browser's leave warning. Closing the desktop window first sends what
	// is typed (the session's `guardWindowClose`); quitting is immediate
	// (ADR-0542).
	beforeNavigate((navigation) => {
		// svelte-ignore state_referenced_locally
		if (session.blocksNavigation(navigation)) navigation.cancel();
	});

	/** Below this width the sidebar becomes a bottom bar and panes take turns. */
	const wide = new MediaQuery('(min-width: 768px)');

	function toggleFiles() {
		if (wide.current) view.filesPane = !view.filesPane;
		else view.filesSheet = !view.filesSheet;
	}

	/** Show what was just opened: a transformation on its page, anything else beside the recordings. */
	function showOpened(path: string) {
		view.filesSheet = false;
		if (library.selectedTransformationPath === path) {
			view.showingTransformation = true;
			void goto(resolve('/transformations'));
		} else {
			view.showingDetail = true;
			void goto(resolve('/recordings'));
		}
	}
</script>

<svelte:window
	onkeydown={(event) => {
		if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'e') {
			event.preventDefault();
			toggleFiles();
		}
	}}
/>

{#snippet header()}
	<AppHeader
		{library}
		filesOpen={wide.current ? view.filesPane : view.filesSheet}
		onToggleFiles={toggleFiles}
	/>
{/snippet}

{#if wide.current}
	<Sidebar.Provider bind:open={view.sidebarOpen} class="h-dvh min-h-0 overflow-hidden">
		<VerticalNav />
		<Sidebar.Inset class="min-h-0 overflow-hidden">
			{@render header()}
			<Resizable.PaneGroup direction="horizontal" class="min-h-0 flex-1">
				{#if view.filesPane}
					<Resizable.Pane id="files" order={1} defaultSize={22} minSize={14} maxSize={40}>
						<FileBrowser {library} onOpen={showOpened} />
					</Resizable.Pane>
					<Resizable.Handle />
				{/if}
				<Resizable.Pane id="page" order={2} defaultSize={view.filesPane ? 78 : 100} minSize={40}>
					<div class="flex h-full min-h-0 flex-col overflow-y-auto" data-testid="page">{@render children()}</div>
				</Resizable.Pane>
			</Resizable.PaneGroup>
		</Sidebar.Inset>
	</Sidebar.Provider>
{:else}
	<div class="flex h-dvh flex-col overflow-hidden">
		{@render header()}
		<main class="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="page">
			{@render children()}
		</main>
		<BottomNav />
		<Sheet.Root bind:open={view.filesSheet}>
			<!-- Named directly: the browser's own visible heading is the only "Files" heading. -->
			<Sheet.Content side="left" class="gap-0 p-0" aria-label="Files">
				<FileBrowser {library} onOpen={showOpened} />
			</Sheet.Content>
		</Sheet.Root>
	</div>
{/if}
