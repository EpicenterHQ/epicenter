<!--
	Everything that exists because the store is open: the UI session, its typed
	context, its query client, and the whole of the app chrome.

	Mounted only from the `ready` branch of the (app) layout's boot, so `data` is
	an open store from the moment this initialises. The session is built during
	initialisation, its context is supplied synchronously, and the session-owned
	TanStack client is installed for the descendant tree.

	**It does not open the store, and it must not.** Opening belongs to the boot
	node, which is the narrowest node not shared with `/auth/callback`
	(ADR-0345); an open that slid down here would still build and still pass
	every other test, which is what `boot-node.test.ts` pins. That test matches
	on source text, so do not write the call in this comment either.

	It owns the teardown for exactly what it built. The replica underneath is NOT
	its to close: that is the document's (ADR-0088), and `$lib/epicenter.svelte.ts`
	holds the only reference that could end it.

	This absorbed `WhisperingUiSessionProvider`, which was a component wrapping
	one `createWhisperingUiSession` call. It existed because the layout had no
	shell to put the session in, unlike Honeycrisp's `StoreShell` and Vocab's
	`VocabShell`, which both do this inline. Now there is one.
-->
<script lang="ts">
	import type { Account } from "@epicenter/auth";
	import { PersistenceNotice } from '@epicenter/app-shell/persistence-notice';
	import { fromData } from '@epicenter/svelte';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { onDestroy, type Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { createLogger } from 'wellcrafted/logger';
	import DictationIndicator from '#platform/dictation-indicator';
	import type { WhisperingAccountData } from '$lib/whispering/app';
	import { setWhisperingContext } from '$lib/whispering/context';
	import {
		createWhisperingUiSession,
		WhisperingUiSessionError,
	} from '$lib/whispering/ui-session';
	import AppEffects from './AppEffects.svelte';
	import BottomNav from './BottomNav.svelte';
	import ContentShell from './ContentShell.svelte';
	import GlobalDialogs from './GlobalDialogs.svelte';
	import VerticalNav from './VerticalNav.svelte';

	const log = createLogger('whispering/ui-session');

	let {
		data: opened,
		account,
		removeLocalData,
		children,
	}: {
		/**
		 * The open replica, raw. The session component hands over what `open()`
		 * resolved, and the adaptation happens here rather than above, because
		 * this component mounts exactly once per opened store and `fromData` is
		 * per store. Reads on an unadapted store do not track, and every domain
		 * built below would have gone quiet with nothing to say why.
		 */
		data: WhisperingAccountData;
		account: Account | null;
		/**
		 * Sign out and remove this account's local data, owned by the session
		 * component above because only it can sequence the close. Absent where
		 * the platform cannot remove one account's audio and leave another's.
		 */
		removeLocalData?: () => Promise<void>;
		children: Snippet;
	} = $props();

	// One mount creates one immutable session/provider pair. `data` is the store
	// this branch was entered with; a different store means a different document.
	/* svelte-ignore state_referenced_locally */
	const data = fromData(opened);
	/* svelte-ignore state_referenced_locally */
	const session = createWhisperingUiSession({
		data: opened,
		blobs: opened.blobs,
		account,
	});

	setWhisperingContext({ app: session.app, queries: session.queries });

	export function close(): Promise<void> {
		return session[Symbol.asyncDispose]();
	}

	onDestroy(() =>
		void close().catch((cause: unknown) => {
			log.warn(WhisperingUiSessionError.TeardownFailed({ cause }));
		}),
	);

	let sidebarOpen = $state(false);

	// Sidebar when wide, bottom bar on narrow viewports (phone, small window).
	const isNarrow = new MediaQuery('(max-width: 767px)');
</script>

<PersistenceNotice persistence={data.persistence} />

<QueryClientProvider client={session.queryClient}>
	<!-- Uses UI package defaults (300ms delay, 150ms skip) -->
	<Tooltip.Provider>
		<!-- Once, at the session root and outside the responsive nav branch, so
		     switching between the two navs does not re-run it. -->
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
				<VerticalNav {removeLocalData} />
				<Sidebar.Inset>
					<ContentShell>{@render children()}</ContentShell>
				</Sidebar.Inset>
			</Sidebar.Provider>
		{/if}

		<GlobalDialogs />
		<DictationIndicator />
	</Tooltip.Provider>
</QueryClientProvider>
