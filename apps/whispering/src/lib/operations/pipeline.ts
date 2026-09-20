import {
	deliverTranscriptionResult,
	type TranscriptionSource,
} from '$lib/operations/delivery';
import { polishWillRun, runPolish } from '$lib/operations/run-polish';
import { playSoundIfEnabled } from '$lib/operations/sound';
import {
	type captureTranscription,
	transcribeAndPersist,
} from '$lib/operations/transcribe';
import { saveRecordingHistory } from '$lib/operations/transcription-history';
import { report } from '$lib/report';
import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';
import { polishHud } from '$lib/state/polish-hud.svelte';
import type { WhisperingApp } from '$lib/whispering/app';
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
	const recording = app.library.tables.recordings.get(recordingId);
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
				title: 'Audio saved',
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
		await transcribeAndPersist(app, recording.id, transcribe);
	if (lifetime.aborted || !app.recordingEnabled) return;

	if (transcribeError) {
		const action = creditAction(transcribeError, app.account);
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
	const showPolishHud = willPolish && isDictation && ownsFeedback();
	let signal: AbortSignal | undefined;
	if (showPolishHud) {
		dictationLifecycle.markPolishing();
		signal = polishHud.begin(ownsFeedback);
	}
	const { data: polishedText, error: polishError } = await runPolish(app, {
		input: transcribedText,
		signal,
	});
	if (signal) polishHud.end(signal);
	if (lifetime.aborted || !app.recordingEnabled) return;
	// Polish is best-effort: a failed AI pass carries the raw transcript in
	// `fallback`, so a transcript is never lost to a polish error. Surface the
	// failure without blocking delivery.
	const deliveredText = polishError ? polishError.fallback : polishedText;
	if (polishError && ownsFeedback()) {
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
		const polishedHistory = saveRecordingHistory(app, recording.id, {
			polishedTranscript: polishedText,
		});
		if (polishedHistory.error !== null) history = polishedHistory;
	}
	if (lifetime.aborted || !app.recordingEnabled) return;

	// The transcript is "ready" once it is polished and about to be delivered, so
	// the completion sound and the resolved loading notice both fire here.
	if (ownsFeedback()) void playSoundIfEnabled(app, 'transcriptionComplete');
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
