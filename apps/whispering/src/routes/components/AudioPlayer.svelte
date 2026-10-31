<script lang="ts">
	import { type AudioFile, getLibrary } from '$lib/library.svelte.js';

	/** Play recording `id`'s audio. A file that changes is read again. */
	let { id, file, label }: {
		id: string;
		/** The audio file the recording has, as listed. */
		file: AudioFile;
		label: string;
	} = $props();
	const library = getLibrary();

	let current = $state<string | undefined>();
	let problem = $state<string | undefined>();

	// Each read owns its URL until the file changes or this player leaves.
	$effect(() => {
		void [file.ext, file.version];
		current = undefined;
		problem = undefined;
		let url: string | undefined;
		let live = true;
		void library.readAudio(id).then(({ data, error }) => {
			if (!live) return;
			if (error !== null) problem = error;
			else
				url = current = URL.createObjectURL(
					// SAFETY: storage reads answer bytes over a plain ArrayBuffer.
					new Blob([data.bytes as Uint8Array<ArrayBuffer>], { type: data.mimeType }),
				);
		});
		return () => {
			live = false;
			if (url) URL.revokeObjectURL(url);
		};
	});
</script>

{#if problem}
	<p class="text-xs text-destructive" role="alert">The audio could not be loaded: {problem}</p>
{/if}
{#if current}
	<audio class="h-10 w-full" controls preload="metadata" src={current} aria-label={label} data-testid="audio-player"></audio>
{:else if !problem}
	<p class="text-xs text-muted-foreground">Loading audio…</p>
{/if}
