<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import * as Modal from '@epicenter/ui/modal';
	import { Separator } from '@epicenter/ui/separator';
	import { Textarea } from '@epicenter/ui/textarea';
	import { TimezoneCombobox } from '@epicenter/ui/timezone-combobox';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { createQuery } from '@tanstack/svelte-query';
	import { extractErrorMessage } from 'wellcrafted/error';
	import type { RecordingEditor } from '$lib/whispering/recording-editor';
	import AudioBlobPlayer from '$lib/components/AudioBlobPlayer.svelte';
	import { deleteRecordingsWithConfirmation } from '$lib/operations/delete-recordings';
	import { report } from '$lib/report';
	import { createCopyFn } from '$lib/utils/createCopyFn';
	import DownloadRecordingButton from './actions/DownloadRecordingButton.svelte';
	import TranscribeRecordingButton from './actions/TranscribeRecordingButton.svelte';
	import RecordingStorageAction from './RecordingStorageAction.svelte';
	import RecordingStorageBadge from './RecordingStorageBadge.svelte';
	import {
		getRecordingEditor,
		getWhisperingApp,
		getWhisperingQueries,
	} from '$lib/whispering/context';

	const app = getWhisperingApp();
	const queries = getWhisperingQueries();

	const editor = getRecordingEditor();
	let {
		active,
		isOpen,
	}: {
		active: NonNullable<RecordingEditor['state']['active']>;
		isOpen: boolean;
	} = $props();
	const recording = $derived(active.recording);
	const workingCopy = $derived({ ...recording, ...active.values });
	/**
	 * Audio playback URL via TanStack Query, fetched lazily once the modal
	 * opens. Gating on `isOpen` keeps closed forms from eagerly acquiring
	 * local blob URLs.
	 */
	const audioAvailabilityQuery = createQuery(() => ({
		...queries.audio.availability(() => recording).options,
		enabled: isOpen,
	}));

	const deliveredTranscript = $derived(
		workingCopy.transcript !== recording.transcript
			? workingCopy.transcript
			: (recording.polishedTranscript ?? workingCopy.transcript),
	);
	const fieldNames = {
		title: 'Title',
		recordedAt: 'Recorded at',
		recordedAtZone: 'Recorded timezone',
		transcript: 'Transcript',
	};

	function remove() {
		const target = $state.snapshot(recording);
		void deleteRecordingsWithConfirmation(app, target, {
			onSuccess: () => {
				editor.discard(target.id);
				if (editor.state.active?.recording.id === target.id) editor.close();
			},
		});
	}

	function save() {
		const { data, error } = editor.save(recording.id);
		if (error !== null) {
			report.info({
				title: 'Could not update recording',
				description: extractErrorMessage(error.cause),
			});
			return;
		}
		if (data.status === 'saved') {
			report.success({ title: 'Recording saved' });
		} else if (data.status === 'invalid-time') {
			report.info({
				title: 'Recorded at is not a valid timestamp',
				description: 'Use a UTC ISO timestamp like 2026-06-13T16:20:00.000Z.',
			});
		} else if (data.status === 'conflict') {
			report.info({ title: 'Review the saved changes before saving' });
		}
	}
</script>

<Modal.Content class="sm:max-w-2xl">
	<Modal.Header>
		<Modal.Title>{recording.title || 'Untitled recording'}</Modal.Title>
		<Modal.Description>
			Closing keeps your draft until you reload, quit, or sign out.
		</Modal.Description>
	</Modal.Header>

	<div class="space-y-4 p-4">
		{#if active.missing}
			<p role="status">This recording is no longer available. Your unfinished input is still here to copy or discard.</p>
		{/if}
		{#each active.conflicts as conflict (conflict.field)}
			<div class="space-y-2 rounded-lg border p-3" role="status">
				<p>{fieldNames[conflict.field]} changed since you started editing.</p>
				<p class="text-muted-foreground text-sm">Latest saved version:</p>
				<pre class="max-h-40 overflow-auto whitespace-pre-wrap break-words text-sm">{conflict.saved || '(empty)'}</pre>
				{#if conflict.field === 'transcript' && conflict.polishedTranscript !== null}
					<p class="text-muted-foreground text-sm">Saving your edit also removes this delivered transcript:</p>
					<pre class="max-h-40 overflow-auto whitespace-pre-wrap break-words text-sm">{conflict.polishedTranscript}</pre>
				{/if}
				<div class="flex flex-wrap gap-2">
					<Button variant="outline" onclick={() => editor.useSaved(recording.id, conflict.field)}>Use saved version</Button>
					<Button variant="outline" onclick={() => editor.keepDraft(recording.id, conflict)}>Keep my edit</Button>
				</div>
			</div>
		{/each}
		{#if !active.missing}
			<div class="flex items-center gap-2">
				<RecordingStorageBadge {recording} />
				<RecordingStorageAction {recording} />
			</div>

			{#if audioAvailabilityQuery.data === 'local-only' ||
				audioAvailabilityQuery.data === 'local-and-remote'}
				<AudioBlobPlayer
					id={recording.audioBlobId}
					enabled={isOpen}
					class="h-9 w-full"
				/>
			{:else if audioAvailabilityQuery.data === 'remote-only'}
				<p class="text-muted-foreground text-sm">
					Download the audio to play it on this device.
				</p>
			{:else if audioAvailabilityQuery.data === 'unavailable'}
				<p class="text-destructive text-sm">
					The audio is no longer available locally or online.
				</p>
			{/if}

		{/if}
		{#if workingCopy.polishedTranscript}
			<div class="space-y-2">
				<div class="flex items-center justify-between gap-2">
					<Label for="delivered-transcript">Delivered transcript</Label>
					<CopyButton
						text={workingCopy.polishedTranscript}
						copyFn={createCopyFn('delivered transcript')}
						variant="outline"
					/>
				</div>
				<Textarea
					id="delivered-transcript"
					value={workingCopy.polishedTranscript}
					readonly
					rows={6}
				/>
			</div>
		{/if}

		<div class="space-y-2">
			<Label for="transcript">
				{workingCopy.polishedTranscript ? 'Original transcript' : 'Transcript'}
			</Label>
			<Textarea
				id="transcript"
				value={workingCopy.transcript}
				oninput={(e) => editor.edit(recording.id, 'transcript', e.currentTarget.value)}
				rows={12}
			/>
		</div>

		{#if !active.missing}
			<div class="flex flex-wrap gap-2">
				<TranscribeRecordingButton
					{recording}
					variant="outline"
					size="sm"
					showLabel
				/>
				<DownloadRecordingButton
					{recording}
					variant="outline"
					size="sm"
					showLabel
				/>
			</div>

		{/if}
		<Separator />

		<div class="space-y-4">
			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="title" class="text-right">Title</Label>
				<Input
					id="title"
					value={workingCopy.title}
					oninput={(e) => editor.edit(recording.id, 'title', e.currentTarget.value)}
					class="col-span-3"
				/>
			</div>
			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="recordedAt" class="text-right">Recorded At</Label>
				<Input
					id="recordedAt"
					value={workingCopy.recordedAt}
					oninput={(e) => editor.edit(recording.id, 'recordedAt', e.currentTarget.value)}
					class="col-span-3"
				/>
			</div>
			<div class="grid grid-cols-4 items-center gap-4">
				<Label class="text-right">Recorded Timezone</Label>
				<div class="col-span-3">
					<TimezoneCombobox
						bind:value={() => workingCopy.recordedAtZone,
							(value) => editor.edit(recording.id, 'recordedAtZone', value)}
					/>
				</div>
			</div>
		</div>
	</div>

	<Modal.Footer>
		{#if !active.missing}
			<Button
				variant="destructive"
				onclick={remove}
			>
				<TrashIcon class="size-4" />
				Delete
			</Button>
		{/if}
		<div class="flex-1"></div>
		<Button variant="outline" disabled={!active.dirty} onclick={() => editor.discard(recording.id)}>Discard draft</Button>
		<Button variant="outline" onclick={() => editor.close()}>
			Close
		</Button>
		<CopyButton
			text={deliveredTranscript}
			copyFn={createCopyFn('transcript')}
			variant="outline"
			size="default"
			disabled={!deliveredTranscript.trim()}
		>
			Copy
		</CopyButton>
		<Button onclick={save} disabled={!active.dirty || active.missing || active.conflicts.length > 0}>Save</Button>
	</Modal.Footer>
</Modal.Content>
