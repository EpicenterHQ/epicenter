<script lang="ts">
	import { getWhispering } from '$lib/whispering.svelte.js';
	import { createQuery } from '@tanstack/svelte-query';
	import { audioRead } from '$lib/file-reads.js';

	/** Play a finished file; live capture owns its bytes until Stop finalizes them. */
	let { path, label }: {
		path: string;
		label: string;
	} = $props();
	const { library } = getWhispering();
	const capture = $derived(library.capturePhase(path));
	const reading = createQuery(() => ({
		...library.local.queries.file(path, audioRead),
		enabled: capture === undefined,
	}));
	const audio = $derived(capture === undefined ? reading.data : undefined);
	const problem = $derived(capture === undefined ? reading.error?.message : undefined);

	let url = $state<string | undefined>();

	// The decoded value keeps its identity across rereads of unchanged bytes.
	// Each changed Blob owns its URL until it is replaced or this view leaves.
	$effect(() => {
		if (audio === undefined) {
			url = undefined;
			return;
		}
		const current = URL.createObjectURL(audio.blob);
		url = current;
		return () => URL.revokeObjectURL(current);
	});
</script>

{#if capture !== undefined}
	<p class="text-xs text-muted-foreground" role="status">{capture === 'recording' ? 'Recording…' : 'Stopping…'}</p>
{:else}
	{#if problem}
		<p class="text-xs text-destructive" role="alert">The audio could not be loaded: {problem}</p>
	{/if}
	{#if url}
		<audio class="h-10 w-full" controls preload="metadata" src={url} aria-label={label} data-testid="audio-player"></audio>
	{:else if !problem}
		<p class="text-xs text-muted-foreground">Loading audio…</p>
	{/if}
{/if}
