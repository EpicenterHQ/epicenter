<script lang="ts">
	import type { Client } from '@epicenter/definition/contract';
	import * as Alert from '@epicenter/ui/alert';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { onDestroy, type Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import type { Whispering as WhisperingContract } from '$lib/contract.js';
	import { createWhispering, setWhispering } from '$lib/whispering.svelte.js';
	import AppHeader from './AppHeader.svelte';
	import BottomNav from './BottomNav.svelte';
	import VerticalNav from './VerticalNav.svelte';

	/** Product state over this browser's files and, signed in, the repository; stops taking work when it leaves. */
	let {
		device,
		repository,
		children,
	}: {
		device: Client<WhisperingContract>;
		repository: Client<WhisperingContract> | null;
		children: Snippet;
	} = $props();

	// Each mounted product root keeps the sides it received.
	// svelte-ignore state_referenced_locally
	const whispering = createWhispering({ device, repository });
	setWhispering(whispering);
	const { view } = whispering;
	const starting = whispering.start();
	// Leaving waits for nothing; a recording under way ends with the page.
	onDestroy(whispering.dispose);

	/** Below this width the sidebar becomes a bottom bar. */
	const wide = new MediaQuery('(min-width: 768px)');
</script>

{#snippet header()}
	<AppHeader />
	{#if whispering.files.deviceError}
		<Alert.Root variant="warning" class="rounded-none" data-testid="device-unavailable">
			<Alert.Title>This browser is not keeping files for Whispering</Alert.Title>
			<Alert.Description>
				{whispering.files.deviceError.message}. A private window keeps none. A recording stays in this page, to save again or download, until it closes.
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

{:catch error}
	<Empty.Root class="h-dvh">
		<Empty.Header>
			<Empty.Title>Whispering could not start</Empty.Title>
			<Empty.Description role="alert">{extractErrorMessage(error)}</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{/await}
