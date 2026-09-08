import type { BlobId } from '@epicenter/blobs';
import { InstantString } from '@epicenter/data/field';
import { createLogger } from 'wellcrafted/logger';
import {
	deliverTranscriptionResult,
	type TranscriptionSource,
} from '$lib/operations/delivery';
import { polishWillRun, runPolish } from '$lib/operations/run-polish';
import { playSoundIfEnabled } from '$lib/operations/sound';
import { transcribeAndPersist } from '$lib/operations/transcribe';
import { saveRecordingHistory } from '$lib/operations/transcription-history';
import { report } from '$lib/report';
import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';
import { polishHud } from '$lib/state/polish-hud.svelte';
import type { WhisperingApp } from '$lib/whispering/app';

const log = createLogger('whispering/pipeline');

/**
 * Argument shape for the pipeline. The recorder produces a
 * `RecorderStopResult`; the VAD path and file import path build the
 * equivalent finalized shape. `deliverySource` is forwarded
 * straight to delivery, so it shares delivery's `TranscriptionSource` type.
 */
type PipelineInput = {
	audioBlobId: BlobId;
	durationMs: number | null;
	deliverySource?: TranscriptionSource;
};

/**
 * Processes finalized local audio through row creation, transcription, and
 * polishing.
 *
 * Audio bytes never live in pipeline state. Every acquisition path has
 * committed the local blob before calling this operation.
 *
 * `deliverySource` only shapes the success copy (recording vs file import).
 */
export async function processRecordingPipeline(
	app: WhisperingApp,
	{ audioBlobId, durationMs, deliverySource = 'recording' }: PipelineInput,
) {
	const now = InstantString.now();

	// A live dictation (not a file import) drives the dictation pill. The
	// recorder is already idle by the time we get here, so the lifecycle hands
	// the pill from `recording` to `transcribing`. File imports have their own
	// surface, so they leave the dictation lifecycle untouched.
	const isDictation = deliverySource === 'recording';
	// Row creation awaits cleanup of committed audio if its row cannot be written.
	const { data: recording, error: creationError } = await app.recordings.create(
		{
			audioBlobId,
			title: '',
			recordedAt: now,
			recordedAtZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			transcript: '',
			polishedTranscript: null,
			duration: durationMs,
			// The recording domain initializes the transcription columns explicitly, so
			// a fresh recording is `pending` with no completion and no error.
		},
	);
	if (creationError !== null) {
		if (isDictation)
			dictationLifecycle.markFailed({
				tier: 'silent-loss',
				error: creationError,
			});
		throw creationError;
	}
	if (isDictation) dictationLifecycle.markTranscribing();

	if (
		app.settings.get('recordingAutoUpload') &&
		app.recordings.remoteAvailable
	) {
		// The row is committed before discovery, and every automatic upload uses
		// the same flight. A new recording during a pass schedules another pass.
		void app.recordings.backup.kick().catch((cause: unknown) => {
			log.warn(new Error('Backup after recording threw', { cause }));
		});
	}

	// File import has no pill, so it keeps a progress toast; the dictation path is
	// driven by the lifecycle markers above (the pill), with no toast.
	const transcribeLoading = isDictation
		? null
		: report.loading({
				title: '📋 Transcribing...',
				description: 'Your recording is being transcribed...',
			});

	const { data: transcription, error: transcribeError } =
		await transcribeAndPersist(app, recording.id, audioBlobId);

	if (transcribeError) {
		if (isDictation) {
			dictationLifecycle.markFailed({
				tier: 'transcription',
				error: transcribeError,
			});
		} else {
			transcribeLoading?.reject({ cause: transcribeError });
		}
		return;
	}
	const { text: transcribedText } = transcription;
	let history = transcription.history;

	// Run Polish over the raw transcript, then deliver the polished text. When
	// history succeeds, the raw stays on `recordings.transcript` so "show
	// original" is recoverable. We hold delivery until Polish finishes and
	// deliver once, with the final text: delivering the raw and then the polished
	// version would land two copies (a clipboard the user might paste mid-polish,
	// or two cursor pastes), the exact race the deliver-after-polish rule exists to
	// dodge. Polish is the only thing on the automatic path; there is no
	// auto-running Recipe. See ADR-0099.
	//
	// The "Polishing…" HUD and its ship-raw control live on the dictation pill, so
	// the lifecycle's polishing phase and the abort signal are dictation-only: file
	// import has no pill to cancel from and keeps its own progress toast. The pill
	// shows the HUD only when an AI pass actually runs (not in speed mode); begin/end
	// bracket the call so the controller is dropped on success, failure, or abort.
	const willPolish = polishWillRun(app, transcribedText);
	const showPolishHud = willPolish && isDictation;
	let signal: AbortSignal | undefined;
	if (showPolishHud) {
		dictationLifecycle.markPolishing();
		signal = polishHud.begin();
	}
	const { data: polishedText, error: polishError } = await runPolish(app, {
		input: transcribedText,
		signal,
	});
	if (showPolishHud) polishHud.end();
	// Polish is best-effort: a failed AI pass carries the raw transcript in
	// `fallback`, so a transcript is never lost to a polish error. Surface the
	// failure without blocking delivery.
	const deliveredText = polishError ? polishError.fallback : polishedText;
	if (polishError) {
		report.info({
			title: 'Polishing skipped',
			description: polishError.message,
		});
	}

	// Attempt to persist the polished transcript alongside the raw transcript so
	// history can show what was actually delivered, with the original one click
	// away. Only write when a Polish pass actually produced a result: row creation
	// already left `polishedTranscript` null, so speed mode (no AI call) and a
	// polish failure (the fallback delivers the raw words) need no second write.
	if (willPolish && !polishError) {
		const polishedHistory = await saveRecordingHistory(app, recording.id, {
			polishedTranscript: polishedText,
		});
		if (polishedHistory.error !== null) history = polishedHistory;
	}

	// The transcript is "ready" once it is polished and about to be delivered, so
	// the completion sound and the resolved loading notice both fire here.
	void playSoundIfEnabled(app, 'transcriptionComplete');
	const { outcome: transcriptDelivery, notice: transcribeNotice } =
		await deliverTranscriptionResult(app, {
			text: deliveredText,
			source: deliverySource,
		});
	if (isDictation) {
		// The delivered transcript is the dictation receipt. Every reach is a success,
		// even when history could not be confirmed, so this is always `delivered`; the reach decides
		// whether the pill flashes (clean `output`) or persists (a reduced
		// `clipboard`).
		dictationLifecycle.markDelivered(transcriptDelivery.reach);
	} else {
		transcribeLoading?.resolve(transcribeNotice);
	}
	if (history.error !== null) {
		report.info({
			title: 'Transcription delivered, but history may be incomplete',
			description: history.error.message,
		});
	}
}
