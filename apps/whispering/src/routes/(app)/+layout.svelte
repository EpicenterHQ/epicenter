<!--
	The (app) route layout is the session root and the boot owner. It mounts
	once and persists across navigation, so the application is acquired
	exactly once per launch: the raw {#await} below owns pending, fulfilled,
	and failed rendering from the moment this component initialises, and the
	fulfilled branch mounts the provider that supplies the ready application
	to every descendant. AppEffects, GlobalDialogs, and the build-selected
	DictationIndicator start exactly once, inside the ready subtree. Only the
	nav chrome and ContentShell swap on a breakpoint change.
-->
<script lang="ts">
	import {
		StorageMovedScreen,
		storageMoved,
	} from '@epicenter/app-shell/storage-moved';
	import { WorkspaceBootFailure } from '@epicenter/app-shell/workspace-gate';
	import { Loading } from '@epicenter/ui/loading';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { onDestroy } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { auth } from '#platform/auth';
	import DictationIndicator from '#platform/dictation-indicator';
	import { whisperingPlatform } from '#platform/whispering';
	import { log } from '$lib/report';
	import WhisperingAppProvider from '$lib/whispering/WhisperingAppProvider.svelte';
	import { createWhisperingUiSessionOpening } from '$lib/whispering/ui-session-opening';
	import { openWhisperingUiSession } from '$lib/whispering/ui-session';
	import AppEffects from './_components/AppEffects.svelte';
	import BottomNav from './_components/BottomNav.svelte';
	import ContentShell from './_components/ContentShell.svelte';
	import GlobalDialogs from './_components/GlobalDialogs.svelte';
	import VerticalNav from './_components/VerticalNav.svelte';

	let { children } = $props();

	let sidebarOpen = $state(false);

	// Sidebar when wide, bottom bar on narrow viewports (phone, small window).
	const isNarrow = new MediaQuery('(max-width: 767px)');

	// Created during component initialisation, so the {#await} owns the
	// acquisition before any failure can settle. Boot retry is a full page
	// reload. Unmount/HMR aborts an in-flight acquisition; after fulfillment,
	// this route owner drains shell, query, and application resources together.
	const owner = createWhisperingUiSessionOpening((signal) =>
		openWhisperingUiSession(whisperingPlatform, signal),
	);
	const opening = owner.opening;
	const dispose = () =>
		void owner[Symbol.asyncDispose]().catch((cause) => {
			log.warn(
				cause instanceof Error ? cause : new Error(String(cause)),
				'Whispering UI session teardown failed',
			);
		});
	onDestroy(dispose);
	$effect(() => {
		if (storageMoved.current) dispose();
	});
</script>

{#if storageMoved.current}
	<StorageMovedScreen />
{:else}
	{#await opening}
		<Loading class="h-dvh" />
	{:then session}
		<WhisperingAppProvider {session}>
			<!-- Uses UI package defaults (300ms delay, 150ms skip) -->
			<Tooltip.Provider>
				<AppEffects />

				{#if isNarrow.current}
					<div class="flex h-full min-h-svh flex-col">
						<div class="flex-1 pb-14">
							<ContentShell>{@render children()}</ContentShell>
						</div>
						<BottomNav />
					</div>
				{:else}
					<Sidebar.Provider bind:open={sidebarOpen}>
						<VerticalNav />
						<Sidebar.Inset>
							<ContentShell>{@render children()}</ContentShell>
						</Sidebar.Inset>
					</Sidebar.Provider>
				{/if}

				<GlobalDialogs />
				<DictationIndicator />
			</Tooltip.Provider>
		</WhisperingAppProvider>
	{:catch error}
		<WorkspaceBootFailure {error} onSignOut={() => auth.signOut()} />
	{/await}
{/if}
