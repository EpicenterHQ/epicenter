<script lang="ts">
	import type { Account } from "@epicenter/auth";
	import { PersistenceNotice } from '@epicenter/app-shell/persistence-notice';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { onDestroy, type Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import DictationIndicator from '#platform/dictation-indicator';
	import type { WhisperingAppHandle, WhisperingData } from '$lib/whispering/app';
	import { setWhisperingContext } from '$lib/whispering/context';
	import {
		createWhisperingUiSession,
	} from '$lib/whispering/ui-session';
	import AppEffects from './AppEffects.svelte';
	import BottomNav from './BottomNav.svelte';
	import ContentShell from './ContentShell.svelte';
	import GlobalDialogs from './GlobalDialogs.svelte';
	import VerticalNav from './VerticalNav.svelte';


	let {
		openedApp,
		data,
		account,
		libraryMenu,
		children,
	}: {
		/** The ready framework App, owned and closed by the application document. */
		openedApp: WhisperingAppHandle;
		data: WhisperingData;
		account: Account | undefined;
		children: Snippet;
		libraryMenu: Snippet;
	} = $props();

	// One mount creates one UI session over the captured framework App.
	/* svelte-ignore state_referenced_locally */
	const session = createWhisperingUiSession({
		openedApp,
		data,
		account,
	});

	setWhisperingContext({ app: session.app, queries: session.queries });

	onDestroy(() => {
		session[Symbol.dispose]();
	});

	let sidebarOpen = $state(false);

	// Sidebar when wide, bottom bar on narrow viewports (phone, small window).
	const isNarrow = new MediaQuery('(max-width: 767px)');
</script>

<PersistenceNotice persistence={session.app.library.persistence} />

	<QueryClientProvider client={session.queryClient}>
		<!-- Uses UI package defaults (300ms delay, 150ms skip) -->
		<Tooltip.Provider>
			<!-- Once, at the session root and outside the responsive nav branch, so
			     switching between the two navs does not re-run it. -->
			<AppEffects />

			{#if isNarrow.current}
				<div class="flex h-full min-h-svh flex-col">
					<div class="flex-1 pb-14">
						<div class="flex justify-end px-4 pt-3">{@render libraryMenu()}</div>
						<ContentShell>{@render children()}</ContentShell>
					</div>
					<BottomNav />
				</div>
			{:else}
				<Sidebar.Provider bind:open={sidebarOpen}>
					<VerticalNav {libraryMenu} />
					<Sidebar.Inset>
						<ContentShell>{@render children()}</ContentShell>
					</Sidebar.Inset>
				</Sidebar.Provider>
			{/if}

			<GlobalDialogs />
			<DictationIndicator />
		</Tooltip.Provider>
	</QueryClientProvider>
