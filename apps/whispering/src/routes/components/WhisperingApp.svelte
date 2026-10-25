<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import * as Resizable from '@epicenter/ui/resizable';
	import * as Sheet from '@epicenter/ui/sheet';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { toast } from '@epicenter/ui/sonner';
	import { onDestroy, type Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { setFolder, type WhisperingFolder } from '$lib/folder.js';
	import { createWhispering, setWhispering } from '$lib/whispering.svelte.js';
	import { describeError } from '$lib/files.js';
	import AppHeader from './AppHeader.svelte';
	import BottomNav from './BottomNav.svelte';
	import FileBrowser from './FileBrowser.svelte';
	import VerticalNav from './VerticalNav.svelte';

	/** Product state over the opened folder; stops taking work before the folder closes. */
	let {
		folder,
		children,
	}: { folder: WhisperingFolder; children: Snippet } = $props();

	// Each mounted product root keeps the folder it received.
	// svelte-ignore state_referenced_locally
	setFolder(folder);
	// svelte-ignore state_referenced_locally
	const whispering = createWhispering(folder, (action, error) => {
		toast.error(action, { description: describeError(error) });
	});
	setWhispering(whispering);
	const { view } = whispering;
	const starting = whispering.start();
	// Leaving waits for nothing; a recording under way ends with the page.
	onDestroy(whispering.dispose);

	/** Below this width the sidebar becomes a bottom bar and panes take turns. */
	const wide = new MediaQuery('(min-width: 768px)');

	function toggleFiles() {
		if (wide.current) view.filesPane = !view.filesPane;
		else view.filesSheet = !view.filesSheet;
	}

	/** Show what was just opened: a transformation on its page, anything else beside the recordings. */
	function showOpened(path: string) {
		view.filesSheet = false;
		if (whispering.selectedTransformationPath === path) {
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
			<Alert.Title>Git defaults could not be checked at startup</Alert.Title>
			<Alert.Description>
				{whispering.exclusionNotice} Open .gitignore in Files to repair it, then reload Whispering to check again. Non-Markdown files may be included in Git commits.
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
