<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { isTauri } from '@tauri-apps/api/core';
	import { listen } from '@tauri-apps/api/event';
	import '@epicenter/ui/app.css';
	import { dictation } from '#lib/dictation.svelte.ts';
	import { queryClient } from '#lib/queries.ts';
	import { settings } from '#lib/settings.svelte.ts';

	let { children } = $props();

	// The global shortcut (⌘⇧;) is held in Rust (`main.rs`), which sends each
	// press here; it does what the Record button does. A browser has none.
	$effect(() => {
		if (!isTauri()) return;
		const unlisten = listen('toggle-recording', () => dictation.toggle());
		return () => {
			void unlisten.then((stop) => stop());
		};
	});
</script>

<QueryClientProvider client={queryClient}>
	<Tooltip.Provider>
		<!-- Settings are read once, before the first screen, so it never shows the wrong server. -->
		{#await settings.loaded then}
			{@render children()}
		{/await}
	</Tooltip.Provider>
</QueryClientProvider>

<ConfirmationDialog />
<Toaster offset={16} closeButton />
