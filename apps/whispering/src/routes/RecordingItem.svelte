<!--
	One recording in the feed. Closed, it is one line with Copy; open, its
	transcript is edited in place, with Play and Delete. A recording with audio
	and no transcript offers Transcribe; while the server has it, the row shows
	a spinner and its transcript cannot be edited.

	An edit is a draft here until its save lands: a refetch of the list never
	overwrites it, and an edit made while the save was in flight stays.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import { IconButton } from '@epicenter/ui/icon-button';
	import { Spinner } from '@epicenter/ui/spinner';
	import { Textarea } from '@epicenter/ui/textarea';
	import { toastOnError } from '@epicenter/ui/toast-on-error';
	import PlayIcon from '@lucide/svelte/icons/play';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { runMutation } from 'wellcrafted/query';
	import { dictation } from '#lib/dictation.svelte.ts';
	import { formatDuration } from '#lib/feed.ts';
	import { queryClient, recordingsMutations } from '#lib/queries.ts';
	import type { Recording } from '#lib/recordings.ts';
	import AudioPlayer from './AudioPlayer.svelte';

	let {
		recording,
		open,
		onOpen,
	}: { recording: Recording; open: boolean; onOpen: () => void } = $props();

	let draft = $state<string>();
	/** The audio loads only when the person asks to hear it. */
	let playing = $state(false);

	const transcript = $derived(draft ?? recording.transcript);
	const transcribing = $derived(dictation.isTranscribing(recording.id));
	/** Offered only when nothing would be overwritten: no saved transcript and no draft. */
	const canTranscribe = $derived(recording.audio && !transcribing && !transcript);
	const time = $derived(
		recording.at?.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) ??
			recording.id,
	);
	const length = $derived(
		recording.durationMs === undefined ? 'unknown length' : formatDuration(recording.durationMs),
	);

	async function save() {
		const submitted = draft;
		if (submitted === undefined) return;
		const saved = await runMutation(queryClient, recordingsMutations.setTranscript, {
			id: recording.id,
			transcript: submitted,
		});
		if (saved.error) return toastOnError(saved, 'Could not save the transcript');
		if (draft === submitted) draft = undefined;
	}

	function confirmDelete() {
		confirmationDialog.open({
			title: 'Delete this recording?',
			description: 'Its audio and transcript are deleted from this computer.',
			confirm: { text: 'Delete', variant: 'destructive' },
			onConfirm: async () => {
				dictation.forget(recording.id);
				const deleted = await runMutation(queryClient, recordingsMutations.delete, { id: recording.id });
				toastOnError(deleted, 'Could not delete the recording');
			},
		});
	}
</script>

{#if open}
	<article class="flex flex-col gap-3 rounded-lg border p-4">
		<header class="flex items-center gap-2 text-sm text-muted-foreground">
			<span class="tabular-nums">{time} · {length}</span>
			<span class="flex-1"></span>
			{#if transcribing}
				<Spinner />
			{:else if canTranscribe}
				<Button size="sm" variant="ghost" onclick={() => dictation.transcribe(recording.id)}>
					Transcribe
				</Button>
			{:else}
				<CopyButton text={transcript} size="sm" variant="ghost" disabled={!transcript}>Copy</CopyButton>
			{/if}
			<IconButton label="Delete" size="sm" variant="ghost" onclick={confirmDelete}>
				<Trash2Icon />
			</IconButton>
		</header>
		<Textarea
			aria-label="Transcript"
			placeholder={transcribing ? 'Transcribing...' : 'No transcript yet. Type one here.'}
			class="max-h-80 min-h-24"
			disabled={transcribing}
			bind:value={() => transcript, (text) => (draft = text)}
			onblur={save}
		/>
		{#if recording.audio}
			{#if playing}
				<AudioPlayer id={recording.id} />
			{:else}
				<Button variant="outline" size="sm" class="self-start" onclick={() => (playing = true)}>
					<PlayIcon />
					Play
				</Button>
			{/if}
		{/if}
	</article>
{:else}
	<div class="flex items-center gap-3 rounded-md px-4 py-2 text-sm hover:bg-muted">
		<button type="button" class="flex min-w-0 flex-1 items-center gap-3 text-left" onclick={onOpen}>
			<span class="shrink-0 tabular-nums text-muted-foreground">{time} · {length}</span>
			{#if transcribing}
				<Spinner class="text-muted-foreground" />
			{:else}
				<span class="truncate" class:text-muted-foreground={!transcript}>
					{transcript.split('\n', 1)[0] || 'No transcript'}
				</span>
			{/if}
		</button>
		{#if canTranscribe}
			<Button size="sm" variant="ghost" onclick={() => dictation.transcribe(recording.id)}>Transcribe</Button>
		{:else if transcript}
			<CopyButton text={transcript} size="sm" variant="ghost">Copy</CopyButton>
		{/if}
	</div>
{/if}
