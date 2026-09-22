<script lang="ts">
	import { openRecordingAudio } from '../whispering/recordings.js';

	import type { BlobSource } from '@epicenter/blobs';
	import { createLogger } from 'wellcrafted/logger';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { getWhisperingApp } from '$lib/whispering/context';

	let {
		id,
		enabled = true,
		class: className,
		viewTransitionName,
	}: {
		id: string;
		enabled?: boolean;
		class?: string;
		viewTransitionName?: string;
	} = $props();

	const app = getWhisperingApp();
	const audioBlobId = $derived(app.library.tables.recordings.get(id)?.audioBlobId);
	const audioUrl = $derived(app.library.tables.recordings.get(id)?.audioUrl ?? null);
	const log = createLogger('whispering/audio-player');
	let handle = $state.raw<BlobSource | null>(null);
	let failure = $state<string | null>(null);

	// The source outlives any lexical scope (`using` cannot span a component
	// lifetime), so effect teardown owns the manual [Symbol.dispose]() call.
	$effect(() => {
		failure = null;
		if (!enabled || !audioBlobId) {
			handle = null;
			return;
		}

		let cancelled = false;
		let owned: BlobSource | null = null;
		void openRecordingAudio(app.localBlobs, app.remoteBlobs, { audioBlobId, audioUrl })
			.then(({ data, error }) => {
				if (error && !cancelled) failure = 'Audio is unavailable on this device.';
				if (data === null) return;
				if (cancelled) {
					data[Symbol.dispose]();
					return;
				}
				owned = data;
				handle = data;
			})
			.catch((cause: unknown) => {
				if (!cancelled) {
					failure = 'Could not open audio on this device.';
					log.error(new Error(extractErrorMessage(cause), { cause }));
				}
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
{#if failure}<span class="text-sm text-muted-foreground">{failure}</span>{/if}
