<!--
	Whispering over one contract client, which the variant's root passes in:
	the services, the connections, the microphone and the recorder
	(`createWhispering`), the library the pages read (`createLibrary` over
	`filesOf(client)`), and the frame around the pages. Made once for the
	page; it stops taking work when it leaves.
-->
<script lang="ts">
	import type { Client } from '@epicenter/definition/contract';
	import * as Alert from '@epicenter/ui/alert';
	import * as Empty from '@epicenter/ui/empty';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { onDestroy, type Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import type { Whispering as WhisperingContract } from '$lib/contract.js';
	import { filesOf } from '$lib/files.svelte.js';
	import { createLibrary, setLibrary } from '$lib/library.svelte.js';
	import { createWhispering, setWhispering } from '$lib/whispering.svelte.js';
	import AppHeader from './AppHeader.svelte';
	import BottomNav from './BottomNav.svelte';
	import VerticalNav from './VerticalNav.svelte';

	let {
		client,
		children,
	}: {
		/** Whispering's files for this page's whole life: the variant's store. */
		client: Client<WhisperingContract>;
		children: Snippet;
	} = $props();

	// One client for the component's life.
	// svelte-ignore state_referenced_locally
	const whispering = createWhispering({ client });
	setWhispering(whispering);
	// svelte-ignore state_referenced_locally
	const library = createLibrary({ whispering, files: filesOf(client) });
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
	{#if library.error}
		<Alert.Root variant="warning" class="rounded-none" data-testid="device-unavailable">
			<Alert.Title>This browser is not keeping files for Whispering</Alert.Title>
			<Alert.Description>
				{library.error.message}. A private window keeps none. A recording stays in this page, to save again or download, until it closes.
			</Alert.Description>
		</Alert.Root>
	{/if}
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
