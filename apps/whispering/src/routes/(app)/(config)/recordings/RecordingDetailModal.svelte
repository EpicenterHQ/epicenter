<script lang="ts">
	import { updateRecording } from '../../../../lib/whispering/recordings.js';

	import { extractErrorMessage } from 'wellcrafted/error';
	import { PromotionInspectionRequired } from '@epicenter/capture';
	import { CAPTURE_PROMOTION_AVAILABLE } from '#platform/capture-window';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import * as Modal from '@epicenter/ui/modal';
	import { Separator } from '@epicenter/ui/separator';
	import { Spinner } from '@epicenter/ui/spinner';
	import { Textarea } from '@epicenter/ui/textarea';
	import { TimezoneCombobox } from '@epicenter/ui/timezone-combobox';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { createQuery } from '@tanstack/svelte-query';
	import { onDestroy, type Snippet } from 'svelte';
	import AudioBlobPlayer from '$lib/components/AudioBlobPlayer.svelte';
	import { deleteRecordingsWithConfirmation } from '$lib/operations/delete-recordings';
	import { addToCapture, inspectCapture, openInCapture, promotionFor } from '$lib/operations/capture-promotion';
	import { report } from '$lib/report';
	import { polishWillRun, runPolish } from '$lib/operations/run-polish';
	import { saveCleanedTranscription } from '$lib/operations/transcription-history';
	import type { Recording } from '../../../../lib/data.js';
	import { createCopyFn } from '$lib/utils/createCopyFn';
	import { transcriptionsForRecording, transcriptionText } from '$lib/whispering/transcriptions';
	import DownloadRecordingButton from './actions/DownloadRecordingButton.svelte';
	import TranscribeRecordingButton from './actions/TranscribeRecordingButton.svelte';
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
		store,
		trigger,
	}: {
		recording: Recording;
		store: import('$lib/whispering/app.js').RecordingStore;
		/** Renders the modal opener; spread the given props onto a single element. */
		trigger: Snippet<[Record<string, unknown>]>;
	} = $props();

	let isDialogOpen = $state(false);
	let previewing = $state(false);
	let destroyed = false;
	let pendingPreviewReceipt: ReturnType<typeof app.pendingSaves.reserve> | null = null;
	let previewController: AbortController | null = null;
	let previewEpoch = 0;
	let selectedResultId = $state<string | null>(null);
	let promoting = $state(false);
	let cleanupPreview = $state.raw<{
		resultId: string;
		rawText: string;
		previousCleaned: string | null;
		candidate: string;
		receipt: ReturnType<typeof app.pendingSaves.reserve>;
	} | null>(null);

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

	const results = $derived(transcriptionsForRecording(store, recording.id));
	const result = $derived(results.find((row) => row.id === selectedResultId) ?? results[0]);
	const displayedTranscript = $derived(transcriptionText(result));
	const originalPromotion = $derived(result && app.authAccount
		? promotionFor(store, result.id, result.rawText, app.authAccount) : undefined);
	const cleanedPromotion = $derived(result?.cleanedText && app.authAccount
		? promotionFor(store, result.id, result.cleanedText, app.authAccount) : undefined);
	async function promote(text: string) {
		if (!result || promoting) return;
		promoting = true;
		try {
			const captureId = await addToCapture(app, store, recording, result.id, text);
			report.success({ title: 'Added to Capture', action: {
				label: 'Open in Capture', onClick: () => openInCapture(app, captureId),
			} });
		} catch (cause) {
			report.info({
				title: cause instanceof PromotionInspectionRequired ? 'Inspect Capture' : 'Capture could not confirm this request',
				description: extractErrorMessage(cause),
				...(cause instanceof PromotionInspectionRequired && { action: {
					label: 'Inspect Capture', onClick: inspectPromotion,
				} }),
			});
		} finally {
			promoting = false;
		}
	}
	async function openPromotion(captureId: string) {
		try { await openInCapture(app, captureId); }
		catch (cause) { report.info({ title: 'Could not open Capture', description: extractErrorMessage(cause) }); }
	}
	async function inspectPromotion() {
		try { await inspectCapture(app); }
		catch (cause) { report.info({ title: 'Could not open Capture', description: extractErrorMessage(cause) }); }
	}
	onDestroy(() => {
		destroyed = true;
		previewEpoch++;
		previewController?.abort();
		pendingPreviewReceipt?.discard();
		cleanupPreview?.receipt.discard();
	});
	$effect(() => {
		if (!isDialogOpen) {
			previewEpoch++;
			previewController?.abort();
			if (cleanupPreview) {
				cleanupPreview.receipt.discard();
				cleanupPreview = null;
			}
		}
	});

	async function retryCleanup() {
		const current = result;
		if (!current || previewing || !polishWillRun(app, current.rawText)) {
			report.info({
				title: 'Cleanup is unavailable',
				description: 'Enable cleanup and choose a text connection first.',
			});
			return;
		}
		cleanupPreview?.receipt.discard();
		cleanupPreview = null;
		const epoch = ++previewEpoch;
		let receipt: ReturnType<typeof app.pendingSaves.reserve>;
		try {
			receipt = app.pendingSaves.reserve('Cleaned transcript');
		} catch (cause) {
			report.info({ title: 'Finish pending saves first', description: extractErrorMessage(cause) });
			return;
		}
		const controller = new AbortController();
		previewController = controller;
		previewing = true;
		pendingPreviewReceipt = receipt;
		try {
			const cleaned = await runPolish(app, { input: current.rawText, signal: controller.signal });
			if (destroyed || !isDialogOpen || app.signal.aborted || epoch !== previewEpoch || result?.id !== current.id || cleaned.error) {
				receipt.discard();
				if (cleaned.error && isDialogOpen)
					report.info({ title: 'Cleanup failed', description: cleaned.error.message });
				return;
			}
			if (cleaned.data === (current.cleanedText ?? current.rawText)) {
				receipt.discard();
				report.info({ title: 'Cleanup suggested no change' });
				return;
			}
			cleanupPreview = {
				resultId: current.id,
				rawText: current.rawText,
				previousCleaned: current.cleanedText,
				candidate: cleaned.data,
				receipt,
			};
			pendingPreviewReceipt = null;
		} catch (cause) {
			receipt.discard();
			if (isDialogOpen)
				report.info({ title: 'Cleanup failed', description: extractErrorMessage(cause) });
		} finally {
			if (previewController === controller) previewController = null;
			if (pendingPreviewReceipt === receipt) pendingPreviewReceipt = null;
			if (!destroyed) previewing = false;
		}
	}

	async function acceptCleanup() {
		const pending = cleanupPreview;
		if (!pending) return;
		if (result?.id !== pending.resultId) {
			pending.receipt.discard();
			cleanupPreview = null;
			report.info({ title: 'A newer transcription is available', description: 'Retry cleanup on the current Original.' });
			return;
		}
		// The save operation owns this receipt even if the modal closes during flush.
		cleanupPreview = null;
		const saved = await saveCleanedTranscription(
			app,
			store,
			pending.resultId,
			{ rawText: pending.rawText, cleanedText: pending.previousCleaned },
			pending.candidate === pending.rawText ? null : pending.candidate,
			pending.receipt,
		);
		if (saved.error)
			report.info({ title: 'Cleaned text needs saving', description: saved.error.message });
		else report.success({ title: 'Cleaned text saved' });
	}

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

	function save() {
		const snapshot = $state.snapshot(workingCopy);
		try {
			updateRecording(store, recording.id, {
				title: snapshot.title,
				recordedAtZone: snapshot.recordedAtZone,
			});
		} catch (cause) {
			report.info({
				title: 'Could not update recording',
				description: extractErrorMessage(cause),
			});
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
				Play it back, inspect its transcriptions, or download it.
			</Modal.Description>
		</Modal.Header>

		<div class="space-y-4 p-4">
			<AudioBlobPlayer
				{store}
				id={recording.id}
				enabled={isDialogOpen}
				class="h-9 w-full"
			/>
			{#if results.length > 1}
				<div class="space-y-2">
					<Label for="transcription-result">Transcription result</Label>
					<select id="transcription-result" class="w-full rounded-md border bg-background p-2 text-sm" value={result?.id ?? ''} onchange={(event) => {
						previewEpoch++;
						previewController?.abort();
						cleanupPreview?.receipt.discard();
						cleanupPreview = null;
						selectedResultId = event.currentTarget.value;
					}}>
						{#each results as item, index (item.id)}
							<option value={item.id}>{index === 0 ? 'Latest: ' : ''}{new Date(item.attemptedAt).toLocaleString()} · {item.rawText.slice(0, 60)}</option>
						{/each}
					</select>
				</div>
			{/if}

			{#if result?.cleanedText}
				<div class="space-y-2">
					<div class="flex items-center justify-between gap-2">
						<Label for="cleaned-transcript">Cleaned transcript</Label>
						<CopyButton
							text={result.cleanedText}
							copyFn={createCopyFn('cleaned transcript')}
							variant="outline"
						/>
						{#if CAPTURE_PROMOTION_AVAILABLE && app.authAccount}
						<Button variant="outline" size="sm" disabled={promoting} onclick={() => cleanedPromotion?.captureId ? openPromotion(cleanedPromotion.captureId) : promote(result!.cleanedText!)}>
								{cleanedPromotion?.captureId ? 'Open in Capture' : cleanedPromotion ? 'Retry request' : 'Add to Capture'}
						</Button>
						{#if cleanedPromotion && !cleanedPromotion.captureId}
							<Button variant="outline" size="sm" onclick={inspectPromotion}>Inspect Capture</Button>
						{/if}
						{/if}
					</div>
					<Textarea
						id="cleaned-transcript"
						value={result.cleanedText}
						readonly
						rows={6}
					/>
				</div>
			{/if}

			<div class="space-y-2">
				<div class="flex items-center justify-between gap-2">
					<Label for="transcript">{result?.cleanedText ? 'Original transcript' : 'Transcript'}</Label>
					{#if result && CAPTURE_PROMOTION_AVAILABLE && app.authAccount}
						<Button variant="outline" size="sm" disabled={promoting} onclick={() => originalPromotion?.captureId ? openPromotion(originalPromotion.captureId) : promote(result!.rawText)}>
							{originalPromotion?.captureId ? 'Open in Capture' : originalPromotion ? 'Retry request' : 'Add to Capture'}
						</Button>
						{#if originalPromotion && !originalPromotion.captureId}
							<Button variant="outline" size="sm" onclick={inspectPromotion}>Inspect Capture</Button>
						{/if}
					{/if}
				</div>
				<Textarea
					id="transcript"
					value={result?.rawText ?? ''}
					readonly
					rows={12}
				/>
			</div>

			{#if result}
				<div class="space-y-2">
					<Button variant="outline" size="sm" disabled={previewing} onclick={retryCleanup}>
						{previewing ? 'Cleaning…' : 'Retry cleanup'}
					</Button>
					{#if cleanupPreview}
						<div class="space-y-3 rounded-md border p-3">
							<p class="text-sm">Compare this suggestion with the {cleanupPreview.previousCleaned ? 'current Cleaned' : 'Original'} text above. Accept it only if it keeps your meaning.</p>
							<Label for="cleanup-candidate">Suggested Cleaned text</Label>
							<Textarea id="cleanup-candidate" value={cleanupPreview.candidate} readonly rows={6} />
							<div class="flex gap-2">
								<Button size="sm" onclick={acceptCleanup}>Use Cleaned text</Button>
								<Button variant="outline" size="sm" onclick={() => {
									cleanupPreview?.receipt.discard();
									cleanupPreview = null;
								}}>Keep current text</Button>
							</div>
						</div>
					{/if}
				</div>
			{/if}

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
					<Label class="text-right">Recorded Timezone</Label>
					<div class="col-span-3">
						<TimezoneCombobox
							bind:value={
								() => workingCopy.recordedAtZone,
								(recordedAtZone) => {
									workingCopy = {
										...workingCopy,
										recordedAtZone:
											recordedAtZone as Recording['recordedAtZone'],
									};
									isWorkingCopyDirty = true;
								}
							}
						/>
					</div>
				</div>
			</div>
		</div>

		<Modal.Footer>
			<Button
				variant="destructive"
				onclick={() =>
					deleteRecordingsWithConfirmation(store, $state.snapshot(recording), {
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
				text={displayedTranscript}
				copyFn={createCopyFn('transcript')}
				variant="outline"
				size="default"
				disabled={!displayedTranscript.trim()}
			>
				Copy
			</CopyButton>
			<Button onclick={save} disabled={!isWorkingCopyDirty}>Save</Button>
		</Modal.Footer>
	</Modal.Content>
</Modal.Root>
