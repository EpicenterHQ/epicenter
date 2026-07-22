<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import {
		getWhisperingApp,
		getWhisperingQueries,
	} from '$lib/whispering/context';
	import type { RecordingId } from '$lib/workspace';

	const app = getWhisperingApp();
	const queries = getWhisperingQueries();

	let {
		id,
		enabled = true,
		class: className,
		viewTransitionName,
	}: {
		id: RecordingId;
		enabled?: boolean;
		class?: string;
		viewTransitionName?: string;
	} = $props();

	const audio = createQuery(() => ({
		...queries.audio.recording(() => id).options,
		enabled,
	}));
	let url = $state<string | null>(null);

	// Record table notifications include blob-lane invalidations. Refetch only
	// this address so unrelated scalar edits do not reread every mounted blob.
	$effect(() =>
		app.recordings.subscribe((changedIds) => {
			if (changedIds.includes(id)) void audio.refetch();
		}),
	);

	// Object URLs outlive a lexical scope, so component effect teardown owns
	// revocation whenever the recording, enabled state, or bytes change.
	$effect(() => {
		const source = audio.data;
		if (!enabled || source === null || source === undefined) return;
		if (typeof source === 'string') {
			url = source;
			return () => {
				if (url === source) url = null;
			};
		}
		const owned = URL.createObjectURL(source);
		url = owned;
		return () => {
			URL.revokeObjectURL(owned);
			if (url === owned) url = null;
		};
	});
</script>

{#if url}
	<audio
		class={className}
		style:view-transition-name={viewTransitionName}
		controls
		src={url}
	>
		Your browser does not support the audio element.
	</audio>
{:else if enabled && audio.isPending}
	<p class={className} aria-live="polite">Loading audio...</p>
{:else if enabled && audio.isError}
	<p class={className} role="alert">Audio could not be loaded.</p>
{:else if enabled && audio.data === null}
	<p class={className}>Audio is unavailable.</p>
{/if}
