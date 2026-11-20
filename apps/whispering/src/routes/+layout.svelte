<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import { toastOnError } from '@epicenter/ui/toast-on-error';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import '@epicenter/ui/app.css';
	import { dictation } from '#lib/dictation.svelte.ts';
	import { onShortcut } from '#lib/platform/index.ts';
	import { runQuery } from 'wellcrafted/query';
	import { queryClient, settingsQueries } from '#lib/queries.ts';

	let { children } = $props();

	/**
	 * Settings are read into the cache before the first screen, so no page
	 * shows the wrong server or opens a form empty. A file that cannot be
	 * read leaves nothing set, and says so.
	 */
	const settingsRead = runQuery(queryClient, settingsQueries.read()).then((read) => {
		if (read.error) toastOnError(read, 'Could not read your settings');
	});

	// The global shortcut (⌘⇧;) does what the Record button does.
	$effect(() => onShortcut((app) => dictation.toggle(app)));
</script>

<QueryClientProvider client={queryClient}>
	<Tooltip.Provider>
		{#await settingsRead then}
			{@render children()}
		{/await}
	</Tooltip.Provider>
</QueryClientProvider>

<ConfirmationDialog />
<Toaster offset={16} closeButton />
