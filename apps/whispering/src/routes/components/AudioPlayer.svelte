<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { onDestroy } from 'svelte';
	import type { LoadedAudio } from '$lib/file-reads.js';
	import type { QueryObserverOptions } from '@tanstack/query-core';

	/** Active audio reads share the folder's query polling and keep unchanged bytes playing. */
	let { source, label }: {
		source:
			| { readonly kind: 'file'; readonly query: QueryObserverOptions<LoadedAudio> }
			| { readonly kind: 'bytes'; readonly bytes: Uint8Array; readonly mimeType: string };
		label: string;
	} = $props();
	const reading = createQuery<LoadedAudio>(() => source.kind === 'file'
		? source.query
		: { queryKey: ['audio-preview'], enabled: false });

	let url = $state<string | undefined>();
	let problem = $state<string | undefined>();
	/** What `url` was made from, when it came from the folder. */
	let loaded: LoadedAudio | undefined;
	let held: string | undefined;

	function show(blob: Blob) {
		if (held) URL.revokeObjectURL(held);
		held = URL.createObjectURL(blob);
		url = held;
		problem = undefined;
	}

	$effect(() => {
		const current = source;
		if (current.kind === 'bytes') {
			loaded = undefined;
			show(new Blob([current.bytes as Uint8Array<ArrayBuffer>], { type: current.mimeType }));
			return;
		}
		const audio = reading.data;
		problem = reading.error?.message;
		if (audio === undefined) {
			url = undefined;
			return;
		}
		if (audio === loaded) return;
		loaded = audio;
		show(audio.blob);
	});

	onDestroy(() => {
		if (held) URL.revokeObjectURL(held);
	});
</script>

{#if problem}
	<p class="text-xs text-destructive" role="alert">The audio could not be loaded: {problem}</p>
{/if}
{#if url}
	<audio class="h-10 w-full" controls preload="metadata" src={url} aria-label={label} data-testid="audio-player"></audio>
{:else if !problem}
	<p class="text-xs text-muted-foreground">Loading audio…</p>
{/if}
