<script lang="ts">
	import type { Account } from '@epicenter/auth';
	import { PersistenceNotice } from '@epicenter/app-shell/persistence-notice';
	import { Button } from '@epicenter/ui/button';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { onDestroy, type Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import DictationIndicator from '#platform/dictation-indicator';
	import { DownloadServiceLive } from '#platform/download';
	import { PERSONAL_DEFAULTS } from '$lib/operations/settings';
	import { report } from '$lib/report';
	import type { WhisperingAppHandle, WhisperingData } from '$lib/whispering/app';
	import { setWhisperingContext } from '$lib/whispering/context';
	import { createWhisperingUiSession } from '$lib/whispering/ui-session';
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

	// Previous device-authored content stays downloadable before signing in.
	// It never becomes a fallback for account reads or gets uploaded automatically.
	const previousDeviceData = $derived({
		dictionary: session.app.local.kv.get('dictionary'),
		polishInstructions: session.app.local.kv.get('polishInstructions'),
		transcriptionPrompt: session.app.local.kv.get('transcriptionPrompt'),
		recipes: session.app.local.tables.recipes.rows.map(
			({ id, name, instructions, icon }) => ({ id, name, instructions, icon }),
		),
	});
	const hasPreviousDeviceData = $derived(
		(previousDeviceData.dictionary?.length ?? 0) > 0 ||
			(Boolean(previousDeviceData.polishInstructions) &&
				previousDeviceData.polishInstructions !==
					PERSONAL_DEFAULTS.polishInstructions) ||
			Boolean(previousDeviceData.transcriptionPrompt) ||
			previousDeviceData.recipes.length > 0,
	);

	onDestroy(() => {
		session[Symbol.dispose]();
	});

	let sidebarOpen = $state(false);

	// Sidebar when wide, bottom bar on narrow viewports (phone, small window).
	const isNarrow = new MediaQuery('(max-width: 767px)');
</script>

<PersistenceNotice persistence={session.app.local.persistence} />
{#if session.app.personal}
	<PersistenceNotice persistence={session.app.personal.persistence} />
{/if}
{#if hasPreviousDeviceData}
	<div class="flex flex-wrap items-center justify-between gap-3 border-b p-3 text-sm">
		<p>Previous dictionary, instructions, or recipes are saved on this device. Download them before signing in or changing accounts, then copy what you need into your account settings.</p>
		<Button variant="outline" onclick={async () => {
			const { error } = await DownloadServiceLive.downloadBlob({
				name: 'whispering-previous-device-data.json',
				blob: new Blob([JSON.stringify(previousDeviceData, null, 2)], { type: 'application/json' }),
			});
			if (error && error.name !== 'SaveCancelled') report.error({ title: 'Download failed', cause: error });
		}}>Download previous data</Button>
	</div>
{/if}

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
