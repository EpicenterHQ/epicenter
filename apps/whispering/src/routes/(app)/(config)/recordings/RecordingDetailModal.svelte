<script lang="ts">
	import { InstantString } from '@epicenter/field';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import * as Modal from '@epicenter/ui/modal';
	import { Separator } from '@epicenter/ui/separator';
	import { Textarea } from '@epicenter/ui/textarea';
	import { TimezoneCombobox } from '@epicenter/ui/timezone-combobox';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { createQuery } from '@tanstack/svelte-query';
	import type { Snippet } from 'svelte';
	import AudioBlobPlayer from '$lib/components/AudioBlobPlayer.svelte';
	import { deleteRecordingsWithConfirmation } from '$lib/operations/recordings';
	import { report } from '$lib/report';
	import type { Recording } from '$lib/state/recordings.svelte';
	import { createCopyFn } from '$lib/utils/createCopyFn';
	import DownloadRecordingButton from './actions/DownloadRecordingButton.svelte';
	import TranscribeRecordingButton from './actions/TranscribeRecordingButton.svelte';
	import RecordingStorageAction from './RecordingStorageAction.svelte';
	import RecordingStorageBadge from './RecordingStorageBadge.svelte';
	import {
		getWhisperingApp,
		getWhisperingQueries,
	} from '$lib/whispering/context';

	const app = getWhisperingApp();
	const queries = getWhisperingQueries();

	/**
	 * The single detail surface for one recording: play it back, read and edit
	 * its transcript and metadata, run transcription, download it, copy the
	 * transcript, or delete it.
	 *
	 * The opener is supplied by the caller via the `trigger` snippet, so the
	 * same modal can be reached from the transcript cell (the textarea preview)
	 * or any other affordance without this component owning a button shape.
	 */
	let {
		recording,
		trigger,
	}: {
		recording: Recording;
		/** Renders the modal opener; spread the given props onto a single element. */
		trigger: Snippet<[Record<string, unknown>]>;
	} = $props();

	let isDialogOpen = $state(false);

	/**
	 * A working copy of the recording that we can safely edit.
	 *
	 * It's like a photocopy of an important document. You don't want to
	 * accidentally mess up the original. You edit the photocopy, submit it,
	 * and the original is updated. Then you get a new photocopy.
	 */
	let workingCopy = $derived(
		// Reset the working copy when new recording data comes in.
		recording,
	);

	/**
	 * Tracks whether the user has made changes to the working copy. Starts
	 * false on fresh upstream data, flips true on the first edit, and resets
	 * when new data arrives or the user saves. Drives the unsaved-changes
	 * prompt and the disabled state of the save button.
	 */
	let isWorkingCopyDirty = $derived.by(() => {
		// Reset dirty flag when new recording data comes in
		recording;
		return false;
	});

	/**
	 * Audio playback URL via TanStack Query, fetched lazily once the modal
	 * opens. Gating on `isDialogOpen` keeps closed rows from eagerly acquiring
	 * local blob URLs.
	 */
	const audioAvailabilityQuery = createQuery(() => ({
		...queries.audio.availability(() => recording).options,
		enabled: isDialogOpen,
	}));

	const deliveredTranscript = $derived(
		workingCopy.polishedTranscript ?? workingCopy.transcript,
	);

	function promptUserConfirmLeave() {
		if (!isWorkingCopyDirty) {
			isDialogOpen = false;
			return;
		}

		confirmationDialog.open({
			title: 'Unsaved changes',
			description: 'You have unsaved changes. Are you sure you want to leave?',
			confirm: { text: 'Leave' },
			onConfirm: () => {
				// Reset working copy and dirty flag
				workingCopy = recording;
				isWorkingCopyDirty = false;

				isDialogOpen = false;
			},
		});
	}

	async function save() {
		const snapshot = $state.snapshot(workingCopy);
		if (!InstantString.is(snapshot.recordedAt)) {
			report.info({
				title: 'Recorded At is not a valid instant',
				description: 'Use a UTC ISO timestamp like 2026-06-13T16:20:00.000Z.',
			});
			return;
		}

		const { error } = await app.recordings.update(recording.id, {
			title: snapshot.title,
			recordedAt: snapshot.recordedAt,
			recordedAtZone: snapshot.recordedAtZone,
			transcript: snapshot.transcript,
			polishedTranscript:
				snapshot.transcript === recording.transcript
					? recording.polishedTranscript
					: null,
		});

		if (error) {
			report.error({ title: 'Could not update recording', cause: error });
			return;
		}

		report.success({
			title: 'Updated recording!',
			description: 'Your recording has been updated successfully.',
		});
		isDialogOpen = false;
	}

</script>

<Modal.Root bind:open={isDialogOpen}>
	<Modal.Trigger>
		{#snippet child({ props })}
			{@render trigger(props)}
		{/snippet}
	</Modal.Trigger>
	<Modal.Content
		class="max-w-2xl"
		onEscapeKeydown={(e) => {
			e.preventDefault();
			if (isDialogOpen) promptUserConfirmLeave();
		}}
		onInteractOutside={(e) => {
			e.preventDefault();
			if (isDialogOpen) promptUserConfirmLeave();
		}}
	>
		<Modal.Header>
			<Modal.Title>{recording.title || 'Untitled recording'}</Modal.Title>
			<Modal.Description>
				Play it back, edit the transcript, transcribe, or download.
			</Modal.Description>
		</Modal.Header>

		<div class="space-y-4 p-4">
			<div class="flex items-center gap-2">
				<RecordingStorageBadge {recording} />
				<RecordingStorageAction {recording} />
			</div>

			{#if audioAvailabilityQuery.data === 'local-only' ||
				audioAvailabilityQuery.data === 'local-and-remote'}
				<AudioBlobPlayer
					id={recording.audioBlobId}
					enabled={isDialogOpen}
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
					oninput={(e) => {
						workingCopy = {
							...workingCopy,
							transcript: e.currentTarget.value,
						};
						isWorkingCopyDirty = true;
					}}
					rows={12}
				/>
			</div>

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

			<Separator />

			<div class="space-y-4">
				<div class="grid grid-cols-4 items-center gap-4">
					<Label for="title" class="text-right">Title</Label>
					<Input
						id="title"
						value={workingCopy.title}
						oninput={(e) => {
							workingCopy = { ...workingCopy, title: e.currentTarget.value };
							isWorkingCopyDirty = true;
						}}
						class="col-span-3"
					/>
				</div>
				<div class="grid grid-cols-4 items-center gap-4">
					<Label for="recordedAt" class="text-right">Recorded At</Label>
					<Input
						id="recordedAt"
						value={workingCopy.recordedAt}
						oninput={(e) => {
							workingCopy = {
								...workingCopy,
								recordedAt: e.currentTarget.value as Recording['recordedAt'],
							};
							isWorkingCopyDirty = true;
						}}
						class="col-span-3"
					/>
				</div>
				<div class="grid grid-cols-4 items-center gap-4">
					<Label class="text-right">Recorded Timezone</Label>
					<div class="col-span-3">
						<TimezoneCombobox
							bind:value={() => workingCopy.recordedAtZone,
								(recordedAtZone) => {
									workingCopy = {
										...workingCopy,
										recordedAtZone:
											recordedAtZone as Recording['recordedAtZone'],
									};
									isWorkingCopyDirty = true;
								}}
						/>
					</div>
				</div>
			</div>
		</div>

		<Modal.Footer>
			<Button
				variant="destructive"
				onclick={() =>
					deleteRecordingsWithConfirmation(app, $state.snapshot(recording), {
						onSuccess: () => {
							isDialogOpen = false;
						},
					})}
			>
				<TrashIcon class="size-4" />
				Delete
			</Button>
			<div class="flex-1"></div>
			<Button variant="outline" onclick={() => promptUserConfirmLeave()}>
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
			<Button onclick={save} disabled={!isWorkingCopyDirty}>Save</Button>
		</Modal.Footer>
	</Modal.Content>
</Modal.Root>
