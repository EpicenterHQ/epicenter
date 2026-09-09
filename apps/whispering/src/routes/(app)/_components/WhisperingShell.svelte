<script lang="ts">
	import { recordingActive } from '$lib/state/recording-active.svelte';
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
	import type { WhisperingAppHandle } from '$lib/whispering/app';
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
		openedApp,
		account,
		removeLocalData,
		children,
	}: {
		/** The ready framework App, owned and closed by the application document. */
		openedApp: WhisperingAppHandle;
		account: Account | null;
		/**
		 * Sign out and remove this account's local data, owned by the session
		 * component above because only it can sequence the close. Absent where
		 * the platform cannot remove one account's audio and leave another's.
		 */
		removeLocalData?: () => Promise<void>;
		children: Snippet;
	} = $props();

	// One mount creates one UI session over the captured framework App.
	/* svelte-ignore state_referenced_locally */
	const view = fromData(openedApp);
	/* svelte-ignore state_referenced_locally */
	const session = createWhisperingUiSession({
		openedApp,
		account,
	});

	setWhisperingContext({ app: session.app, queries: session.queries });

	export async function recoverRecording(): Promise<void> {
		if (!session.app.recordingEnabled) return;
		const recovered = await session.app.recording.recover();
		if (session.app.recordingEnabled && recovered.error) throw recovered.error;
	}

	export async function preflight(): Promise<void> {
		await recoverRecording();
		if (session.app.recordingEnabled && recordingActive(session.app))
			throw new Error('Finish recording and wait for it to save before closing Whispering.');
	}

	export function close(): Promise<void> {
		return session[Symbol.asyncDispose]();
	}

	onDestroy(() =>
		void session[Symbol.asyncDispose]().catch((cause: unknown) => {
			log.warn(WhisperingUiSessionError.TeardownFailed({ cause }));
		}),
	);

	let sidebarOpen = $state(false);

	// Sidebar when wide, bottom bar on narrow viewports (phone, small window).
	const isNarrow = new MediaQuery('(max-width: 767px)');
</script>

<PersistenceNotice persistence={view.persistence} />

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
