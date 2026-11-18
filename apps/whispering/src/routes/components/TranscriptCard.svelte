<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { getLibrary } from '$lib/library.svelte.js';
	import { confirmDelete, copyText, formatTime } from './file-actions.js';
	import { Textarea } from '@epicenter/ui/textarea';
	import SaveProblem from './SaveProblem.svelte';

	/**
	 * One transcript of the recording that is open, edited where it is read,
	 * beside the player. Its text is the body of the transcript's own note,
	 * saved as it is typed.
	 */
	let {
		id: shownId,
	}: {
		/** The transcript's id. The list keys each card by it. */
		id: string;
	} = $props();
	const library = getLibrary();
	// The list keys each card by its note; what is typed is sent to that one.
	// svelte-ignore state_referenced_locally
	const id = shownId;

	/** The transcript's fields, its text included: as typed until its save lands, else as the note holds them. */
	const transcript = library.edit('transcriptions', id);
	const text = $derived(transcript.fields.body ?? '');
</script>

<article class="flex flex-col gap-2 rounded border p-3 text-sm" data-testid="transcription-result">
	<Textarea
		class="min-h-32 resize-y font-sans"
		bind:value={() => text, (value) => (transcript.fields.body = value)}
		placeholder="This transcript has no text."
		aria-label="Transcript of {formatTime(transcript.fields.createdAt) || id}"
		data-testid="transcript-text"
	/>
	<SaveProblem editor={transcript} />
	<footer class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
		<span>{formatTime(transcript.fields.createdAt) || 'Unknown time'} · {transcript.fields.model}</span>
		<span class="ml-auto flex items-center gap-1">
			<Button size="xs" variant="outline" disabled={!text.trim()} onclick={() => void copyText(text, 'the transcript')} data-testid="copy-transcript">
				Copy
			</Button>
			<Button
				size="xs"
				variant="destructive"
				onclick={() => confirmDelete(library, { collection: 'transcriptions', id })}
				data-testid="delete-transcript"
			>
				Delete
			</Button>
		</span>
	</footer>
</article>
