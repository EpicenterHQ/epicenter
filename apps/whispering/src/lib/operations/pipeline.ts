import {
	deliverTranscriptionResult,
	type TranscriptionSource,
} from '$lib/operations/delivery';
import { prepareCleanup } from '$lib/operations/process-cleanup';
import { playSoundIfEnabled } from '$lib/operations/sound';
import {
	type captureTranscription,
	transcribeAndPersist,
} from '$lib/operations/transcribe';
import { report } from '$lib/report';
import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';
import { polishHud } from '$lib/state/polish-hud.svelte';
import type { WhisperingApp } from '$lib/whispering/app';
import { local } from '../whispering/local.js';
import { creditAction } from './credit-action.js';

/**
 * Every producer supplies a saved recording row. The capture attempt owns
 * feedback while inference and history retain their original row and App lifetime.
 */
type PipelineInput = {
	recordingId: string;
	deliverySource?: TranscriptionSource;
	isCurrentAttempt?: () => boolean;
	transcribe: ReturnType<typeof captureTranscription>;
};

/**
 * Transcribes and polishes an existing row without publishing bytes or creating rows.
 *
 * `deliverySource` only shapes the success copy (recording vs file import).
 */
export async function processRecordingPipeline(
	app: WhisperingApp,
	{
		recordingId,
		deliverySource = 'recording',
		isCurrentAttempt,
		transcribe,
	}: PipelineInput,
) {
	const lifetime = app.signal;
	lifetime.throwIfAborted();
	const recording = local.tables.recordings.get(recordingId);
	if (!recording || !app.recordingEnabled) return;

	// A live dictation (not a file import) drives the dictation pill. The
	// recorder is already idle by the time we get here, so the lifecycle hands
	// the pill from `recording` to `transcribing`. File imports have their own
	// surface, so they leave the dictation lifecycle untouched.
	const isDictation = deliverySource === 'recording';
	const ownsFeedback =
		isCurrentAttempt ?? (isDictation ? dictationLifecycle.reset() : () => true);
	if (transcribe === null) {
		if (ownsFeedback()) {
			report.info({
				title: 'Audio saved to Local',
				description:
					'Choose a transcription model when you’re ready to turn it into text.',
			});
		}
		return;
	}
	if (isDictation && ownsFeedback()) dictationLifecycle.markTranscribing();

	// File import has no pill, so it keeps a progress toast; the dictation path is
	// driven by the lifecycle markers above (the pill), with no toast.
	const transcribeLoading = isDictation
		? null
		: report.loading({
				title: '📋 Transcribing...',
				description: 'Your recording is being transcribed...',
			});

	const { data: transcription, error: transcribeError } =
		await transcribeAndPersist(app, local, recording.id, transcribe);
	if (lifetime.aborted || !app.recordingEnabled) return;

	if (transcribeError) {
		const action = creditAction(transcribeError, app.authAccount);
		if (isDictation) {
			if (!ownsFeedback()) return;
			dictationLifecycle.markFailed({
				tier: 'transcription',
				error: transcribeError,
			});
			if (action) report.error({ cause: transcribeError, action });
		} else {
			transcribeLoading?.reject({ cause: transcribeError, action });
		}
		return;
	}
	const { text: transcribedText } = transcription;
	let history = transcription.history;

	// Run cleanup over the Original, then deliver the chosen text. The result row
	// retains its Original for later inspection. We hold delivery until cleanup
	// finishes and deliver once: delivering Original and then Cleaned would land
	// two copies (a clipboard the user might paste mid-cleanup,
	// or two cursor pastes), the exact race the deliver-after-polish rule exists to
	// dodge. Cleanup is the only text operation on the automatic path; there is no
	// another text operation. See ADR-0440.
	//
	// The cleanup HUD and its ship-raw control live on the dictation pill, so
	// the lifecycle's polishing phase and the abort signal are dictation-only: file
	// import has no pill to cancel from and keeps its own progress toast. The pill
	// shows the HUD only when an AI pass actually runs (not in speed mode); begin/end
	// bracket the call so the controller is dropped on success, failure, or abort.
	const cleanup = prepareCleanup(app, local, transcription);
	const showPolishHud = cleanup.willRun && isDictation && ownsFeedback();
	let signal: AbortSignal | undefined;
	if (showPolishHud) {
		dictationLifecycle.markPolishing();
		signal = polishHud.begin(ownsFeedback);
	}
	let cleaned: Awaited<ReturnType<typeof cleanup.run>>;
	try {
		cleaned = await cleanup.run(signal);
	} finally {
		if (signal) polishHud.end(signal);
	}
	const {
		text: deliveredText,
		history: cleanedHistory,
		cleanupError,
	} = cleaned;
	if (lifetime.aborted || !app.recordingEnabled) return;
	// Cleanup is best-effort: a failed AI pass carries the Original in
	// `fallback`, so a transcript is never lost to a cleanup error. Surface the
	// failure without blocking delivery.
	if (cleanupError && ownsFeedback()) {
		report.info({
			title: 'Cleanup skipped',
			description: cleanupError.message,
		});
	}

	// Persist changed Cleaned text on the exact result that retained its Original.
	// Speed mode and cleanup failure leave Cleaned null and deliver Original.
	if (cleanedHistory.error !== null) history = cleanedHistory;
	if (lifetime.aborted || !app.recordingEnabled) return;

	// The transcript is "ready" once it is polished and about to be delivered, so
	// the completion sound and the resolved loading notice both fire here.
	if (ownsFeedback()) void playSoundIfEnabled('transcriptionComplete');
	const { outcome: transcriptDelivery, notice: transcribeNotice } =
		await deliverTranscriptionResult(app, {
			text: deliveredText,
			source: deliverySource,
		});
	if (lifetime.aborted || !app.recordingEnabled) return;
	if (isDictation) {
		// The delivered transcript is the dictation receipt. Every reach is a success,
		// even when history could not be confirmed, so this is always `delivered`; the reach decides
		// whether the pill flashes (clean `output`) or persists (a reduced
		// `clipboard`).
		if (ownsFeedback())
			dictationLifecycle.markDelivered(transcriptDelivery.reach);
	} else {
		transcribeLoading?.resolve(transcribeNotice);
	}
	if (history.error !== null && ownsFeedback()) {
		report.info({
			title: 'Transcription delivered, but history may be incomplete',
			description: history.error.message,
		});
	}
}
