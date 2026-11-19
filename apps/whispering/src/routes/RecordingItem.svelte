<!--
	One recording in the feed. Closed, it is one line with Copy; open, its
	transcript is edited in place, with its audio and Delete.
-->
<script lang="ts">
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import { IconButton } from '@epicenter/ui/icon-button';
	import { Textarea } from '@epicenter/ui/textarea';
	import { toastOnError } from '@epicenter/ui/toast-on-error';
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

	const transcript = $derived(dictation.transcriptOf(recording));
	const time = $derived(
		recording.recordedAt?.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) ?? recording.id,
	);
	const length = $derived(
		recording.durationMs === undefined ? 'unknown length' : formatDuration(recording.durationMs),
	);

	function confirmDelete() {
		confirmationDialog.open({
			title: 'Delete this recording?',
			description: 'Its audio and transcript are deleted from this computer.',
			confirm: { text: 'Delete', variant: 'destructive' },
			onConfirm: async () => {
				dictation.discard(recording.id);
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
			<CopyButton text={transcript} size="sm" variant="ghost" disabled={!transcript}>Copy</CopyButton>
			<IconButton label="Delete" size="sm" variant="ghost" onclick={confirmDelete}>
				<Trash2Icon />
			</IconButton>
		</header>
		<Textarea
			aria-label="Transcript"
			placeholder="No transcript yet. Type one here."
			class="max-h-80 min-h-24"
			bind:value={() => transcript, (text) => dictation.edit(recording.id, text)}
			onblur={() => dictation.save(recording.id)}
		/>
		{#if recording.audio}
			<AudioPlayer id={recording.id} />
		{/if}
	</article>
{:else}
	<div class="flex items-center gap-3 rounded-md px-4 py-2 text-sm hover:bg-muted">
		<button type="button" class="flex min-w-0 flex-1 items-center gap-3 text-left" onclick={onOpen}>
			<span class="shrink-0 tabular-nums text-muted-foreground">{time} · {length}</span>
			<span class="truncate" class:text-muted-foreground={!transcript}>
				{transcript.split('\n', 1)[0] || 'No transcript'}
			</span>
		</button>
		{#if transcript}
			<CopyButton text={transcript} size="sm" variant="ghost">Copy</CopyButton>
		{/if}
	</div>
{/if}
