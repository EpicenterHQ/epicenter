<script lang="ts">
	import { audioMimeTypeOf } from '$lib/audio-format.js';
	import { getFolder } from '$lib/folder.js';
	import { getWhispering } from '$lib/whispering.svelte.js';

	/** Play a finished file; live capture owns its bytes until Stop finalizes them. */
	let { path, label }: {
		path: string;
		label: string;
	} = $props();
	const whispering = getWhispering();
	const folder = getFolder();
	const capture = $derived(whispering.capturePhase(path));
	/** The listed file: audio is not kept, so a new value means its bytes changed. */
	const file = $derived(folder.file(path));

	let current = $state<string | undefined>();
	let problem = $state<string | undefined>();

	// Each read owns its URL until the file changes or this view leaves.
	$effect(() => {
		void file;
		current = undefined;
		problem = undefined;
		if (capture !== undefined) return;
		let url: string | undefined;
		let live = true;
		void folder.read(path).then(({ data, error }) => {
			if (!live) return;
			if (error) problem = error.message;
			else if (data)
				url = current = URL.createObjectURL(
					// SAFETY: storage reads answer bytes over a plain ArrayBuffer.
					new Blob([data as Uint8Array<ArrayBuffer>], {
						type: audioMimeTypeOf(path) ?? '',
					}),
				);
			else problem = `No file exists at '${path}'.`;
		});
		return () => {
			live = false;
			if (url) URL.revokeObjectURL(url);
		};
	});
</script>

{#if capture !== undefined}
	<p class="text-xs text-muted-foreground" role="status">{capture === 'recording' ? 'Recording…' : 'Stopping…'}</p>
{:else}
	{#if problem}
		<p class="text-xs text-destructive" role="alert">The audio could not be loaded: {problem}</p>
	{/if}
	{#if current}
		<audio class="h-10 w-full" controls preload="metadata" src={current} aria-label={label} data-testid="audio-player"></audio>
	{:else if !problem}
		<p class="text-xs text-muted-foreground">Loading audio…</p>
	{/if}
{/if}
