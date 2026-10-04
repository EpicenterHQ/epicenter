<script lang="ts">
	import type { BlobId, BlobSource } from '@epicenter/blobs';
	import { services } from '$lib/services';

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

	let handle = $state<BlobSource | null>(null);

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
		void services.blobSources.open(requestedId).then(({ data }) => {
			if (data === null) return;
			if (cancelled) {
				data[Symbol.dispose]();
				return;
			}
			owned = data;
			handle = data;
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
