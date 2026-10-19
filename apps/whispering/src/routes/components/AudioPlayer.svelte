<script lang="ts">
	import type { FolderFiles } from '@epicenter/folder';
	import { onDestroy } from 'svelte';
	import { type LoadedAudio, loadAudio } from '$lib/audio-source.js';

	/**
	 * Plays audio from the folder, or from bytes still held in this window.
	 * Folder audio is read through the same file API as everything else, so the
	 * desktop app and a browser tab play it the same way.
	 *
	 * `generation` is the folder refresh count. Each new one rereads the file
	 * and compares its bytes' hash, so audio replaced by another program is
	 * picked up even when its length is unchanged, and unchanged audio keeps
	 * playing.
	 */
	let { source, label }: {
		source:
			| { readonly kind: 'file'; readonly files: Pick<FolderFiles, 'read'>; readonly path: string; readonly generation: number }
			| { readonly kind: 'bytes'; readonly bytes: Uint8Array; readonly mimeType: string };
		label: string;
	} = $props();

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
		// Read here so a new refresh generation reruns this effect.
		const { files, path } = current;
		void current.generation;
		// Another file's audio is never shown while this one loads.
		if (loaded !== undefined && loaded.path !== path) url = undefined;
		let cancelled = false;
		void (async () => {
			const { data: audio, error: loadError } = await loadAudio(files, path, loaded);
			if (cancelled) return;
			if (loadError !== null) {
				problem = loadError.message;
				return;
			}
			problem = undefined;
			if (audio === loaded) return;
			loaded = audio;
			show(audio.blob);
		})();
		return () => {
			cancelled = true;
		};
	});

	onDestroy(() => {
		if (held) URL.revokeObjectURL(held);
	});
</script>

{#if problem}
	<p class="text-xs text-destructive" role="alert">The audio could not be loaded: {problem}</p>
{:else if url}
	<audio class="h-10 w-full" controls preload="metadata" src={url} aria-label={label} data-testid="audio-player"></audio>
{:else}
	<p class="text-xs text-muted-foreground">Loading audio…</p>
{/if}
