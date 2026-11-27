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
	import { transcriber } from '#lib/data/settings.ts';
	import { type Keys, type Need, type Outcome, setDictation } from '#lib/dictation-view.ts';
	import { local, paste, pill, shortcuts } from '#lib/platform/index.ts';
	import { isMac, shortcutLabel } from '#lib/shortcut.ts';
	import { shortcutHolds } from '#lib/shortcut-holds.svelte.ts';
	import { runQuery } from 'wellcrafted/query';
	import { modelsQueries, pasteQueries, queryClient, settingsQueries } from '#lib/queries.ts';
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
		else dictation.forgetOld();
	});

	const settings = createQuery(() => settingsQueries.read(), () => queryClient);
	const models = createQuery(() => modelsQueries.list(), () => queryClient);
	const SET_UP = { label: 'Set up transcription', href: '/settings/transcription' };
	/**
	 * What transcription still needs: a server filled in, or the chosen
	 * model downloaded. Nothing until the settings and the models are read,
	 * so no screen flashes a need that is met.
	 */
	/** Whether macOS lets a paste land; asked again when the window comes back from System Settings. */
	const pasteAllowed = createQuery(
		() => ({
			...pasteQueries.allowed(),
			enabled: paste.available && settings.data?.['output.paste'] === true,
			refetchOnWindowFocus: 'always' as const,
		}),
		() => queryClient,
	);
	const pasteNeed = $derived<Need[]>(
		settings.data?.['output.paste'] && paste.available && pasteAllowed.data === false
			? [
					{
						id: 'accessibility',
						met: false,
						problem:
							'Paste at the cursor is off: macOS has not allowed it. Text goes to your clipboard instead.',
						fix: { label: 'Allow it', href: '/settings/output' },
					},
				]
			: [],
	);
	const transcriptionNeeds = $derived.by<Need[]>(() => {
		if (!settings.data) return [];
		const chosen = transcriber(settings.data);
		if (chosen?.kind === 'server') return [];
		if (chosen?.kind === 'local' && local.available) {
			if (!models.data || models.data.some((model) => model.id === chosen.model && model.downloaded))
				return [];
			return [
				{
					id: 'model',
					met: false,
					problem: 'The transcription model is not downloaded. Recordings are kept, without text.',
					fix: SET_UP,
				},
			];
		}
		return [
			{
				id: 'server',
				met: false,
				problem: 'No transcription server is set. Recordings are kept, without text.',
				fix: SET_UP,
			},
		];
	});

	/** The shortcuts' keys, as `settings.json` writes them. */
	const toggleKeys = $derived(settings.data?.['shortcut.toggle'] ?? '');
	const holdKeys = $derived(settings.data?.['shortcut.hold'] ?? '');
	const handsFreeKeys = $derived(settings.data?.['shortcut.handsFree'] ?? '');
	/** The shortcuts as a person reads them; one that is off or not held is left out. */
	const keys = $derived<Keys>({
		toggle: shortcuts.available && !shortcutHolds.problem('toggle') ? shortcutLabel(toggleKeys, isMac()) : '',
		hold:
			shortcuts.available && holdKeys && !shortcutHolds.problem('hold')
				? shortcutLabel(holdKeys, isMac())
				: undefined,
	});
	const needs = $derived<Need[]>([...transcriptionNeeds, ...pasteNeed]);
	const view = { ...dictation, needs: () => needs, keys: () => keys };
	setDictation(view);

	/**
	 * A narrow window keeps the sidebar folded to its icons, so the page has
	 * the room; a wide one shows it as the person last left it.
	 */
	const wide = new MediaQuery('min-width: 768px');
	let sidebarOpen = $state(true);

	const settingsKnown = $derived(settings.data !== undefined);
	// Hold the shortcuts the settings name, again only when one of them
	// changes or the Shortcuts page stops reading a new one. Letting the
	// keys go loses a release under way, so a held take is finished first.
	$effect(() => {
		if (!settingsKnown) return;
		shortcutHolds.paused();
		const keys = { toggle: toggleKeys, hold: holdKeys, handsFree: handsFreeKeys };
		dictation.hold(false);
		void shortcutHolds.apply(keys);
	});
	$effect(() => shortcuts.onPress((name, down) => dictation.press(name, down)));

	const pillOn = $derived(settings.data?.['output.pill'] ?? true);
	// The floating pill shows the take from any app and sends back what was
	// pressed. Turned off in the settings, it is told nothing is happening.
	$effect(() => {
		const outcome: Outcome = pillOn ? dictation.outcome() : { kind: 'none' };
		pill.publish({
			take: pillOn ? dictation.take() : { kind: 'idle' },
			outcome,
			level: dictation.level(),
			silent: dictation.silent(),
			handsFree: pillOn ? dictation.handsFree() : { kind: 'off' },
			keys,
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
