<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { openRecordingAudio } from '../whispering/recordings.js';

	import type { BlobSource } from '@epicenter/blobs';
	import { createLogger } from 'wellcrafted/logger';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { getWhisperingApp } from '$lib/whispering/context';

	const app = getWhisperingApp();
	let {
		id,
		store,
		enabled = true,
		class: className,
		viewTransitionName,
	}: {
		id: string;
		store: import('../whispering/app.js').RecordingStore;
		enabled?: boolean;
		class?: string;
		viewTransitionName?: string;
	} = $props();

	const audioBlobId = $derived(store.tables.recordings.get(id)?.audioBlobId);
	const log = createLogger('whispering/audio-player');
	let handle = $state.raw<BlobSource | null>(null);
	let failure = $state<string | null>(null);
	let retry = $state(0);

	// The source outlives any lexical scope (`using` cannot span a component
	// lifetime), so effect teardown owns the manual [Symbol.dispose]() call.
	$effect(() => {
		retry;
		failure = null;
		if (!enabled || !audioBlobId) {
			if (enabled) failure = 'The recording is unavailable.';
			handle = null;
			return;
		}

		const owner = store;
		const blobId = audioBlobId;
		let cancelled = false;
		let owned: BlobSource | null = null;
		void (async () => {
			if (!('stat' in owner.blobs)) await app.playbackReady;
			return openRecordingAudio(owner, { audioBlobId: blobId });
		})()
			.then(({ data, error }) => {
				if (error && !cancelled) failure = 'Audio could not be opened.';
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
		onerror={() => {
			failure = 'Playback stopped. Reopen audio to try again.';
		}}
		src={handle.url}
	>
		Your browser does not support the audio element.
	</audio>
{/if}
{#if enabled && failure}<span
		role="status"
		class="text-sm text-muted-foreground">{failure}</span
	>
	<Button variant="ghost" size="sm" onclick={() => retry++}>Reopen audio</Button
	>{:else if enabled && !handle}<span
		role="status"
		class="text-sm text-muted-foreground">Loading audio…</span
	>{/if}
