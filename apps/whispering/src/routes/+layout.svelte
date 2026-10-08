<script lang="ts">
	import { Toaster } from '@epicenter/ui/sonner';
	import { ModeWatcher } from 'mode-watcher';
	import { onNavigate } from '$app/navigation';
	import { FlushEditsOnHide } from '@epicenter/svelte';
	import { reloadOnAuthChange } from '@epicenter/auth/svelte';
	import { authClient } from '#platform/auth';
	import { whisperingPath } from '$lib/constants/urls';
	import '@epicenter/ui/app.css';
	// Whispering's brand overrides, layered after the shared theme so they win.
	// Keep this import last among the stylesheets.
	import '../app.css';

	let { children } = $props();

	$effect(() => reloadOnAuthChange(authClient, {
		callbackPath: whisperingPath('/auth/callback'),
		callbackDestination: whisperingPath('/'),
	}));

	// The root layout serves every surface: the (app) group, the auth
	// callback, and the recording-overlay webview. It owns chrome only; the
	// (app) layout owns the app boot, so the other surfaces never
	// open SQLite.

	onNavigate((navigation) => {
		if (!document.startViewTransition) return;
		// We deliberately lengthen the morph below, so honor reduced-motion by
		// skipping the transition entirely (snap to the new page) rather than
		// playing a longer animation for someone who asked for less.
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

		return new Promise((resolve) => {
			document.startViewTransition(async () => {
				resolve();
				await navigation.complete;
			});
		});
	});
</script>

<svelte:head> <title>Whispering</title> </svelte:head>

{@render children()}

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
