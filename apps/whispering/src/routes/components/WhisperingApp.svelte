<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import * as Resizable from '@epicenter/ui/resizable';
	import * as Sheet from '@epicenter/ui/sheet';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { setQueryClientContext } from '@tanstack/svelte-query';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { createLogger } from 'wellcrafted/logger';
	import { onDestroy, type Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { beforeNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { setFolder, type WhisperingContext } from '$lib/folder.js';
	import { createWhispering, setWhispering } from '$lib/whispering.svelte.js';
	import AppHeader from './AppHeader.svelte';
	import BottomNav from './BottomNav.svelte';
	import FileBrowser from './FileBrowser.svelte';
	import VerticalNav from './VerticalNav.svelte';
	import { reportWriteNotice } from './file-actions.js';

	/** Product state over FolderApp's context; stops workflows before the folder closes. */
	let {
		context,
		children,
	}: { context: WhisperingContext; children: Snippet } = $props();

	// Each mounted product root keeps the context it received.
	// svelte-ignore state_referenced_locally
	setFolder(context);
	// svelte-ignore state_referenced_locally
	setQueryClientContext(context.queryClient);
	// svelte-ignore state_referenced_locally
	const whispering = createWhispering(context);
	setWhispering(whispering);
	const { library, view } = whispering;
	const starting = whispering.start();
	const log = createLogger('whispering/app');
	onDestroy(() => {
		void whispering.stop().catch((cause) =>
			log.error(new Error('Whispering did not stop', { cause })),
		);
	});

	// A save of a file's text that failed is told, with the text to copy.
	$effect(() => library.onWriteNotice(reportWriteNotice));

	// Edits not yet saved live only in this window until they land.
	// Moving between this app's pages keeps them, so that is never held back.
	// Leaving the document is: in a browser tab the cancel becomes the
	// browser's leave warning. Closing the desktop window first sends what
	// is typed through the folder context's close guard.
	beforeNavigate((navigation) => {
		// svelte-ignore state_referenced_locally
		if (whispering.blocksNavigation(navigation)) navigation.cancel();
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
		filesOpen={wide.current ? view.filesPane : view.filesSheet}
		onToggleFiles={toggleFiles}
	/>
	{#if whispering.exclusionNotice !== undefined}
		<Alert.Root variant="warning" class="rounded-none">
			<Alert.Title>Audio exclusion could not be confirmed at startup</Alert.Title>
			<Alert.Description>
				{whispering.exclusionNotice} Open .gitignore in Files to repair it, then reload Whispering to check again. Audio may be included in Git commits.
			</Alert.Description>
		</Alert.Root>
	{/if}
{/snippet}

{#await starting}
	<Loading class="h-dvh" label="Opening your recordings…" />
{:then}
	{#if wide.current}
		<Sidebar.Provider bind:open={view.sidebarOpen} class="h-dvh min-h-0 overflow-hidden">
			<VerticalNav />
			<Sidebar.Inset class="min-h-0 overflow-hidden">
				{@render header()}
				<Resizable.PaneGroup direction="horizontal" class="min-h-0 flex-1">
					{#if view.filesPane}
						<Resizable.Pane id="files" order={1} defaultSize={22} minSize={14} maxSize={40}>
							<FileBrowser onOpen={showOpened} />
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
					<FileBrowser onOpen={showOpened} />
				</Sheet.Content>
			</Sheet.Root>
		</div>
	{/if}

{:catch error}
	<Empty.Root class="h-dvh">
		<Empty.Header>
			<Empty.Title>Whispering could not start</Empty.Title>
			<Empty.Description role="alert">{extractErrorMessage(error)}</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{/await}
