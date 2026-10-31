<!--
	One of Whispering's two views (decision 76), with the app's frame around
	its pages: "On this device" over this browser's files, or "Synced" over
	the repository the signed-in boundary set (`getRepo`). Its library
	(`$lib/library.svelte.ts`) lists, edits, runs and deletes in that view's
	files only, for as long as its pages are open.
-->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { getRepo } from '@epicenter/svelte/repo';
	import { onDestroy, type Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import type { Whispering as WhisperingContract } from '$lib/contract.js';
	import { deviceFiles, syncedFiles } from '$lib/files.svelte.js';
	import { createLibrary, setLibrary, type View } from '$lib/library.svelte.js';
	import { getWhispering } from '$lib/whispering.svelte.js';
	import AppHeader from './AppHeader.svelte';
	import BottomNav from './BottomNav.svelte';
	import VerticalNav from './VerticalNav.svelte';

	let { view, children }: { view: View; children: Snippet } = $props();

	const whispering = getWhispering();
	// A view shows one client's files for its life.
	// svelte-ignore state_referenced_locally
	const files = view === 'device' ? deviceFiles(whispering.device) : syncedFiles(getRepo<WhisperingContract>(), whispering.device);
	const library = createLibrary({ whispering, files });
	setLibrary(library);
	onDestroy(library.dispose);

	/** Below this width the sidebar becomes a bottom bar. */
	const wide = new MediaQuery('(min-width: 768px)');
</script>

{#snippet header()}
	<AppHeader />
	{#if library.view === 'device' && library.error}
		<Alert.Root variant="warning" class="rounded-none" data-testid="device-unavailable">
			<Alert.Title>This browser is not keeping files for Whispering</Alert.Title>
			<Alert.Description>
				{library.error.message}. A private window keeps none. A recording stays in this page, to save again or download, until it closes.
			</Alert.Description>
		</Alert.Root>
	{/if}
{/snippet}

{#if wide.current}
	<Sidebar.Provider bind:open={() => whispering.sidebarOpen, (open) => (whispering.sidebarOpen = open)} class="h-dvh min-h-0 overflow-hidden">
		<VerticalNav />
		<Sidebar.Inset class="min-h-0 overflow-hidden">
			{@render header()}
			<div class="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="page">{@render children()}</div>
		</Sidebar.Inset>
	</Sidebar.Provider>
{:else}
	<div class="flex h-dvh flex-col overflow-hidden">
		{@render header()}
		<main class="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="page">
			{@render children()}
		</main>
		<BottomNav />
	</div>
{/if}
