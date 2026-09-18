<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import { onNavigate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { FlushEditsOnHide } from '@epicenter/svelte';
	import '@epicenter/ui/app.css';
	// Whispering's brand overrides, layered after the shared theme so they win.
	// Keep this import last among the stylesheets.
	import '../app.css';

	let { children } = $props();

	// The root layout serves every surface: the (app) group, the auth
	// callback, and the recording-overlay webview. It owns chrome and
	// providers only; the (app) layout owns the app boot, so the other
	// surfaces never open SQLite (ADR-0345).


	onNavigate((navigation) => {
		if (!document.startViewTransition) return;
		// We deliberately lengthen the morph below, so honor reduced-motion by
		// skipping the transition entirely (snap to the new page) rather than
		// playing a longer animation for someone who asked for less.
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

		return new Promise((settle) => {
			document.startViewTransition(async () => {
				settle();
				await navigation.complete;
			});
		});
	});
</script>

<svelte:head> <title>Whispering</title> </svelte:head>

<Tooltip.Provider>{@render children()}</Tooltip.Provider>

<Toaster
	offset={16}
	class="block"
	duration={5000}
	visibleToasts={5}
	closeButton
	toastOptions={{
		classes: {
			toast: 'flex flex-wrap *:data-content:flex-1',
			icon: 'shrink-0',
			actionButton: 'w-full mt-3 inline-flex justify-center',
			closeButton: 'w-full mt-3 inline-flex justify-center',
		},
	}}
/>
<!-- Beside the toaster and outside the (app) group, because the one dialog
     that must outlive the session is the destructive exit's: confirming it
     closes the session, which unmounts everything under the shell, and a
     dialog mounted there would be torn down under the person who is reading
     its outcome. Same placement as Honeycrisp's and Vocab's. -->
<ConfirmationDialog />
<ModeWatcher defaultMode="dark" track={false} />
<FlushEditsOnHide />

<style>
	/* The default UA view-transition runs 0.25s, which is abrupt for the
	   cross-page glyph morphs (ADR 0014) that fly the hero record control up
	   into the topbar. Slow every group and its old/new images by the same
	   amount so the named glyphs and the page crossfade stay in step. This is
	   the one knob: SvelteKit has no duration setting, it is pure CSS on the
	   :root view-transition pseudo-elements (hence :global).

	   0.3s is Material's inter-screen standard and sits in the middle of the
	   100-400ms band research calls responsive (NN/g: 500ms reads as a drag);
	   a gentle nudge up from the abrupt 0.25s UA default. */
	:global(::view-transition-group(*)),
	:global(::view-transition-old(*)),
	:global(::view-transition-new(*)) {
		animation-duration: 0.3s;
	}
</style>
