<script lang="ts">
	import type { RecordingAudio } from '$lib/library.svelte.js';

	/** Why a recording's audio cannot be played or sent now. */
	let { audio }: { audio: Exclude<RecordingAudio, { kind: 'here' }> } = $props();
</script>

<p
	class="text-sm {audio.kind === 'ambiguous' ? 'text-destructive' : 'text-muted-foreground'}"
	role={audio.kind === 'listing' ? 'status' : 'alert'}
	data-testid="audio-missing"
	data-audio={audio.kind}
>
	{#if audio.kind === 'listing'}
		Looking for this recording’s audio…
	{:else if audio.kind === 'ambiguous'}
		More than one audio file has this recording’s id ({audio.exts.join(', ')}). Keep one.
	{:else}
		This recording has no audio file.
	{/if}
</p>
