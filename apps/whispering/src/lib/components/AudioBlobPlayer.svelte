<script lang="ts">
	import type { BlobId, BlobSource } from '@epicenter/blobs';
	import { createLogger } from 'wellcrafted/logger';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { getWhisperingApp } from '$lib/whispering/context';

	let {
		id,
		enabled = true,
		class: className,
		viewTransitionName,
	}: {
		id: BlobId;
		enabled?: boolean;
		class?: string;
		viewTransitionName?: string;
	} = $props();

	const app = getWhisperingApp();
	const log = createLogger('whispering/audio-player');
	let handle = $state.raw<BlobSource | null>(null);

	// The source outlives any lexical scope (`using` cannot span a component
	// lifetime), so effect teardown owns the manual [Symbol.dispose]() call.
	$effect(() => {
		const requestedId = id;
		if (!enabled) {
			handle = null;
			return;
		}

		let cancelled = false;
		let owned: BlobSource | null = null;
		void app.blobs
			.open(requestedId)
			.then(({ data }) => {
				if (data === null) return;
				if (cancelled) {
					data[Symbol.dispose]();
					return;
				}
				owned = data;
				handle = data;
			})
			.catch((cause: unknown) => {
				if (!cancelled)
					log.error(new Error(extractErrorMessage(cause), { cause }));
			});

		return () => {
			cancelled = true;
			owned?.[Symbol.dispose]();
			if (handle === owned) handle = null;
		};
	});
</script>

{#if handle}
	<audio
		class={className}
		style:view-transition-name={viewTransitionName}
		controls
		src={handle.url}
	>
		Your browser does not support the audio element.
	</audio>
{/if}
