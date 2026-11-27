<!--
	The main window's frame: the sidebar, and the strip that shows a take
	under way on any screen but Home, which shows its own. It hands the
	screens the real dictation (`DictationView`), adding what dictation still
	needs, which it reads from the settings, and keeps the floating pill's
	window told.
-->
<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { Toaster } from '@epicenter/ui/sonner';
	import { toastOnError } from '@epicenter/ui/toast-on-error';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { createQuery, QueryClientProvider } from '@tanstack/svelte-query';
	import { MediaQuery } from 'svelte/reactivity';
	import { page } from '$app/state';
	import { dictation } from '#lib/dictation.svelte.ts';
	import { type Need, setDictation } from '#lib/dictation-view.ts';
	import { onShortcut, pill } from '#lib/platform/index.ts';
	import { runQuery } from 'wellcrafted/query';
	import { queryClient, settingsQueries } from '#lib/queries.ts';
	import AppSidebar from './AppSidebar.svelte';
	import RecordingBar from './RecordingBar.svelte';

	let { children } = $props();

	/**
	 * Settings are read into the cache before the first screen, so no page
	 * shows the wrong server or opens a form empty. A file that cannot be
	 * read leaves nothing set, and says so.
	 */
	const settingsRead = runQuery(queryClient, settingsQueries.read()).then((read) => {
		if (read.error) toastOnError(read, 'Could not read your settings');
	});

	const settings = createQuery(() => settingsQueries.read(), () => queryClient);
	const needs = $derived<Need[]>([
		{
			id: 'server',
			met: !!settings.data?.server,
			problem: 'No transcription server is set. Recordings are kept, without text.',
			fix: { label: 'Set up transcription', href: '/settings/transcription' },
		},
	]);
	setDictation({ ...dictation, needs: () => needs.filter((need) => !need.met) });

	/**
	 * A narrow window keeps the sidebar folded to its icons, so the page has
	 * the room; a wide one shows it as the person last left it.
	 */
	const wide = new MediaQuery('min-width: 768px');
	let sidebarOpen = $state(true);

	// The start-and-stop shortcut does what the Record button does, from any app.
	$effect(() => onShortcut(() => dictation.toggle('shortcut')));

	// The floating pill shows the take from any app and sends back what was pressed.
	$effect(() => {
		const outcome = dictation.outcome();
		pill.publish({
			take: dictation.take(),
			outcome,
			level: dictation.level(),
			silent: dictation.silent(),
			handsFree: dictation.handsFree(),
			keys: dictation.keys(),
			cleaning: outcome.kind === 'transcribing' && dictation.isCleaning(outcome.id),
		});
	});
	$effect(() =>
		pill.onAction((action) => {
			if (action.kind === 'toggle') dictation.toggle();
			else if (action.kind === 'cancel') dictation.cancel();
			else if (action.kind === 'dismiss') dictation.dismiss();
			else if (action.kind === 'setHandsFree') dictation.setHandsFree(action.on);
			else dictation.show(action.href);
		}),
	);
</script>

<QueryClientProvider client={queryClient}>
	<Tooltip.Provider>
		{#await settingsRead then}
			<Sidebar.Provider bind:open={() => wide.current && sidebarOpen, (open) => (sidebarOpen = open)}>
				<AppSidebar />
				<Sidebar.Inset class="h-dvh min-w-0">
					{#if page.url.pathname !== '/' && dictation.take().kind !== 'idle'}
						<RecordingBar />
					{/if}
					{@render children()}
				</Sidebar.Inset>
			</Sidebar.Provider>
		{/await}
	</Tooltip.Provider>
</QueryClientProvider>

<ConfirmationDialog />
<Toaster offset={16} closeButton />
