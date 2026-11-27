<!--
	One recording in the reading pane: its transcript to edit, what the server
	wrote when cleanup changed it, its audio, and the files it lives in.

	An edit is a draft here until its save lands: a refetch of the list never
	overwrites it, an edit made while the save was in flight stays, and a save
	that fails says so beside the text, which stays, with Retry.
-->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import { IconButton } from '@epicenter/ui/icon-button';
	import { Spinner } from '@epicenter/ui/spinner';
	import { Textarea } from '@epicenter/ui/textarea';
	import { toastOnError } from '@epicenter/ui/toast-on-error';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { runMutation } from 'wellcrafted/query';
	import { goto } from '$app/navigation';
	import { type Recording, recordings } from '#lib/data/recordings.ts';
	import { getDictation } from '#lib/dictation-view.ts';
	import { formatDuration } from '#lib/feed.ts';
	import { files } from '#lib/platform/index.ts';
	import { queryClient, recordingsMutations } from '#lib/queries.ts';

	let { recording }: { recording: Recording } = $props();

	const dictation = getDictation();

	let draft = $state<string>();
	let saveError = $state<string>();
	/**
	 * The URL the player streams from. It hangs on the audio's path alone, a
	 * string, not on the whole recording, so a refetch of the list does not
	 * reload the player mid-play.
	 */
	const audio = $derived(recording.audio);
	const audioUrl = $derived(audio && recordings.audioUrl(recording.id, audio));

	const transcript = $derived(draft ?? recording.transcript);
	const transcribing = $derived(dictation.isTranscribing(recording.id));
	const cleaning = $derived(dictation.isCleaning(recording.id));
	const when = $derived(
		recording.at?.toLocaleString(undefined, {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
		}) ?? recording.id,
	);

	async function save() {
		const submitted = draft;
		if (submitted === undefined) return;
		const saved = await runMutation(queryClient, recordingsMutations.setTranscript, {
			id: recording.id,
			transcript: submitted,
		});
		if (saved.error) {
			saveError = saved.error.message;
			return;
		}
		saveError = undefined;
		if (draft === submitted) draft = undefined;
	}

	function transcribe() {
		if (!recording.transcript) return dictation.transcribe(recording.id);
		confirmationDialog.open({
			title: 'Transcribe this recording again?',
			description: 'The new transcript replaces the text here, including any edits.',
			confirm: { text: 'Transcribe again' },
			onConfirm: () => {
				draft = undefined;
				dictation.transcribe(recording.id);
			},
		});
	}

	function confirmDelete() {
		confirmationDialog.open({
			title: 'Delete this recording?',
			description: `Its audio and transcript are deleted from ${files.keptIn}.`,
			confirm: { text: 'Delete', variant: 'destructive' },
			onConfirm: async () => {
				dictation.forget(recording.id);
				const deleted = await runMutation(queryClient, recordingsMutations.delete, { id: recording.id });
				if (deleted.error) return toastOnError(deleted, 'Could not delete the recording');
				await goto('/recordings', { replace: true, reset: false });
			},
		});
	}
</script>

<article class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4" aria-label="Recording">
	<header class="flex items-center gap-2">
		<IconButton label="Back to the list" variant="ghost" size="sm" href="/recordings" class="md:hidden">
			<ArrowLeftIcon />
		</IconButton>
		<h2 class="flex-1 text-sm text-muted-foreground tabular-nums">
			{when}{recording.durationMs === undefined ? '' : ` · ${formatDuration(recording.durationMs)}`}
		</h2>
		{#if transcribing}
			<Spinner class="text-muted-foreground" />
		{:else if recording.audio}
			<Button size="sm" variant="ghost" onclick={transcribe}>
				{recording.transcript ? 'Transcribe again' : 'Transcribe'}
			</Button>
		{/if}
		<CopyButton text={transcript} size="sm" variant="outline" disabled={!transcript}>Copy</CopyButton>
		<IconButton label="Delete" size="sm" variant="ghost" onclick={confirmDelete}>
			<Trash2Icon />
		</IconButton>
	</header>

	<Textarea
		aria-label="Transcript"
		placeholder={transcribing ? 'Transcribing...' : 'No transcript yet. Type one here.'}
		class="min-h-40 text-base"
		disabled={transcribing}
		bind:value={() => transcript, (text) => (draft = text)}
		onblur={save}
	/>
	{#if saveError}
		<Alert.Root variant="destructive">
			<Alert.Description>Your edit is not saved yet: {saveError}</Alert.Description>
			<Alert.Action><Button size="sm" variant="outline" onclick={save}>Retry</Button></Alert.Action>
		</Alert.Root>
	{/if}

	{#if cleaning}
		<p class="text-sm text-muted-foreground">Cleaning up...</p>
	{:else if recording.original}
		<details class="text-sm">
			<summary class="cursor-pointer text-muted-foreground">Original, before cleanup</summary>
			<div class="mt-2 flex items-start gap-2">
				<p class="flex-1 whitespace-pre-wrap text-muted-foreground">{recording.original}</p>
				<CopyButton text={recording.original} size="sm" variant="ghost">Copy</CopyButton>
			</div>
		</details>
	{/if}

	{#if audioUrl}
		<!-- `preload="none"`: nothing is read until the person presses play. -->
		{#await audioUrl then { data: src }}
			{#if src}<audio controls preload="none" {src} class="h-9 w-full"></audio>{/if}
		{/await}
	{/if}

	<dl class="mt-auto grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
		<dt>Transcript</dt>
		<dd class="truncate font-mono">{recordings.notePath(recording.id)}</dd>
		<dt>Audio</dt>
		<dd class="truncate font-mono">{recording.audio ?? 'none'}</dd>
		<dt>Kept in</dt>
		<dd>{files.keptIn}</dd>
	</dl>
</article>
