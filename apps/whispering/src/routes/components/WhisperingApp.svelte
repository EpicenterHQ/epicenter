<!--
	Whispering over the capabilities `src/lib/app.ts` opened, rendered by the
	app's root only once its folder is open (`<WhenOpen>`): Whispering itself
	(`createWhispering`: the models, the microphone and the recorder) and the
	library the pages read (`createLibrary` over `filesOf(folder)`), the
	product state each page reads from context, and the frame around the
	pages. Every note is written through the folder, whose `saving()` the
	root's leave guard reads; when its files cannot be reached, the root's
	`<WhenOpen>` says so, and writes wait for them. Made once for the page;
	it stops taking work when it leaves.
-->
<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { onDestroy, type Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { ai, choices, folder, recorder } from '$lib/app.js';
	import { filesOf } from '$lib/files.svelte.js';
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
		choices,
		capture: recorder,
		preferences: localPreferences,
	});
	setWhispering(whispering);
	const library = createLibrary({ whispering, files: filesOf(folder) });
	setLibrary(library);
	// Leaving waits for nothing; a recording under way ends with the page.
	onDestroy(() => {
		library.dispose();
		whispering.dispose();
	});

	/** Below this width the sidebar becomes a bottom bar. */
	const wide = new MediaQuery('(min-width: 768px)');

	// Part of startup: the layout's boundary shows its spinner until it ends.
	const failed = await whispering.start().then(
		() => null,
		(error: unknown) => error,
	);
</script>

{#snippet header()}
	<AppHeader />
{/snippet}

{#if failed !== null}
	<Empty.Root class="h-dvh">
		<Empty.Header>
			<Empty.Title>Whispering could not start</Empty.Title>
			<Empty.Description role="alert">{extractErrorMessage(failed)}</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else if wide.current}
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
