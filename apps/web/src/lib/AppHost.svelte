<!--
	One app, mounted through its contract (`@epicenter/app`): its module
	loads, then `mount` shows it in this element over the open repository,
	at its path. A path that changes under it (Back, Forward, a link) is
	`setPath`, or a fresh mount when the app has none. Leaving unmounts it
	before the repository closes, so its editors close first.
-->
<script lang="ts">
	import type { Mounted, Navigate } from '@epicenter/app';
	import { onMount, untrack } from 'svelte';
	import type { Bundle } from './catalog.js';
	import type { ShellRepository } from './lens.js';

	let { bundle, repo, path, navigate }: { bundle: Bundle; repo: ShellRepository; path: string; navigate: Navigate } = $props();

	let element: HTMLDivElement;
	/** The mounted app, and the path it shows. */
	let shown = $state.raw<{ mounted: Mounted; path: string; again: (path: string) => Mounted }>();
	let failure = $state<string>();

	onMount(() => {
		let gone = false;
		// The bundle and the repository stay fixed until this unmounts: the page keys it by app.
		const { load } = untrack(() => bundle);
		const over = untrack(() => repo);
		void load().then(
			({ mount }) => {
				if (gone) return;
				const again = (at: string) => mount(element, { repo: over, path: at, navigate });
				const at = untrack(() => path);
				shown = { mounted: again(at), path: at, again };
			},
			(cause: unknown) => {
				failure = cause instanceof Error ? cause.message : String(cause);
			},
		);
		return () => {
			gone = true;
			void shown?.mounted.unmount();
		};
	});

	$effect(() => {
		const next = path;
		const current = untrack(() => shown);
		if (current === undefined || current.path === next) return;
		if (current.mounted.setPath !== undefined) {
			current.mounted.setPath(next);
			shown = { ...current, path: next };
			return;
		}
		void current.mounted.unmount();
		shown = { ...current, mounted: current.again(next), path: next };
	});
</script>

{#if failure !== undefined}
	<p class="p-6 text-sm text-destructive" role="alert">Could not load {bundle.manifest.name}: {failure}</p>
{/if}
<div bind:this={element} class="h-full" data-app={bundle.manifest.hostname}></div>
