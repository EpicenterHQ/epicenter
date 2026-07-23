<!--
	One data session and its chrome. The parent layout keys this component on
	the authenticated identity (ADR-0178: sign-in selects a replica), so a
	login or logout tears the whole session down and boots the newly selected
	replica. Within one key, the app is acquired exactly once: the raw
	{#await} below owns pending, fulfilled, and failed rendering from the
	moment this component initialises, and the fulfilled branch mounts the
	provider that supplies the ready app to every descendant.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Loading } from '@epicenter/ui/loading';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { onDestroy, type Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { auth } from '#platform/auth';
	import DictationIndicator from '#platform/dictation-indicator';
	import { unclaimedImport, whisperingPlatform } from '#platform/whispering';
	import { log } from '$lib/report';
	import WhisperingUiSessionProvider from '$lib/whispering/WhisperingUiSessionProvider.svelte';
	import { createWhisperingUiSessionOpening } from '$lib/whispering/ui-session-opening';
	import { openWhisperingUiSession } from '$lib/whispering/ui-session';
	import AppEffects from './AppEffects.svelte';
	import BottomNav from './BottomNav.svelte';
	import ContentShell from './ContentShell.svelte';
	import GlobalDialogs from './GlobalDialogs.svelte';
	import UnclaimedImportPrompt from './UnclaimedImportPrompt.svelte';
	import VerticalNav from './VerticalNav.svelte';

	let { children }: { children: Snippet } = $props();

	let sidebarOpen = $state(false);

	// Sidebar when wide, bottom bar on narrow viewports (phone, small window).
	const isNarrow = new MediaQuery('(max-width: 767px)');

	// Created during component initialisation, so the {#await} owns the
	// acquisition before any failure can settle. Boot retry is a full page
	// reload. Unmount/HMR aborts an in-flight acquisition; after fulfillment,
	// this session owner drains shell, query, and app resources together.
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

	const isSignedIn = auth.state.status === 'signed-in';
</script>

{#await opening}
	<Loading class="h-dvh" />
{:then session}
	<WhisperingUiSessionProvider {session}>
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
			{#if unclaimedImport !== undefined && isSignedIn}
				<UnclaimedImportPrompt capability={unclaimedImport} />
			{/if}
			<DictationIndicator />
		</Tooltip.Provider>
	</WhisperingUiSessionProvider>
{:catch error}
	<div class="flex h-dvh flex-col items-center justify-center gap-4 p-8 text-center">
		<h1 class="text-lg font-semibold">Whispering could not start</h1>
		<p class="text-muted-foreground max-w-md text-sm">
			{error instanceof Error ? error.message : String(error)}
		</p>
		<div class="flex gap-2">
			<Button onclick={() => location.reload()}>Reload</Button>
			<Button variant="outline" onclick={() => auth.signOut()}>Sign out</Button>
		</div>
	</div>
{/await}
