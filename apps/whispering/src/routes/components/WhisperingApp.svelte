<!--
	Whispering over the capabilities `src/lib/app.ts` opened, rendered by the
	app's root only once its folder was read: Whispering itself
	(`createWhispering`: the models, the microphone and the recorder) and the
	library the pages read (`createLibrary` over the folder), the product
	state each page reads from context, and the frame around the pages.
	While a take runs, leaving the page asks first: a browser keeps a take
	in memory until Stop (ADR-0779). Made once for the page; it stops taking
	work when it leaves.
-->
<script lang="ts">
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { onDestroy, type Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { ai, folder, recorder } from '$lib/app.js';
	import { createLibrary, setLibrary } from '$lib/library.svelte.js';
	import { localPreferences } from '$lib/microphone-preference.js';
	import { createWhispering, setWhispering } from '$lib/whispering.svelte.js';
	import AppHeader from './AppHeader.svelte';
	import BottomNav from './BottomNav.svelte';
	import VerticalNav from './VerticalNav.svelte';

	let { children }: { children: Snippet } = $props();

	const whispering = createWhispering({
		folder,
		ai,
		choices: folder.settings.choices,
		capture: recorder,
		preferences: localPreferences,
	});
	setWhispering(whispering);
	const library = createLibrary({ whispering, files: folder });
	setLibrary(library);
	// Leaving waits for nothing; a recording under way ends with the page.
	onDestroy(() => {
		library.dispose();
		whispering.dispose();
	});

	/** Below this width the sidebar becomes a bottom bar. */
	const wide = new MediaQuery('(min-width: 768px)');

</script>

{#snippet header()}
	<AppHeader />
{/snippet}

<svelte:window
	onbeforeunload={(event) => {
		if (whispering.recorder.phase !== 'idle') event.preventDefault();
	}}
/>

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
