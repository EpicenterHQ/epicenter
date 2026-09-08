/**
 * Vocab dictation: a continuous voice-activity-detection session over
 * `@epicenter/recorder`. The package owns the microphone and utterance
 * segmentation (Silero VAD; assets served from `/vad/`, see vite.config.ts);
 * this controller owns the UI-facing cycle: it mirrors the session into a
 * reactive status and transcribes each spoken phrase through the shared
 * `transcribe` client. One device-wide singleton, because there is one mic.
 *
 * A session is tap-to-open, tap-to-close. Inside it, every pause-delimited
 * phrase becomes one transcription handed to `onTranscript` as a `Result`; the
 * caller routes text into its input and errors to its toast layer. A failed
 * phrase does not end the session.
 *
 * Transcription is a stateless service (the spec's star/service/library model):
 * this holds no preferences and reaches for no sync. It pulls only the device
 * connection registry and Vocab's own app-local model constant.
 *
 * The transport comes from `resolveOrHosted(VOCAB_STT_MODEL)`, the same predicate
 * chat uses. `whisper-1` is not in Vocab's hosted *chat* catalog, so nothing
 * "serves" it and the call falls back to the hosted transport: the STT gateway on
 * the same `<origin>/v1` Connection base, zero setup, metered. A user who added
 * their own OpenAI key that serves `whisper-1` dictates through that key instead,
 * off Epicenter credits, exactly like a custom chat model resolves first. So the
 * honest path is the registry's, not a hosted transport rebuilt here.
 */

import { type TranscribeError, transcribe } from '@epicenter/client';
import {
	createVadRecorder,
	type DeviceStreamError,
	type VadRecorderError,
} from '@epicenter/recorder';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { base } from '$app/paths';
import { VOCAB_STT_MODEL } from '$lib/data';
import type { createVocabConnections } from './inference-connections.svelte';

/**
 * Where the mic is: closed, waiting for speech, or capturing a phrase.
 * Transcription runs beside the session, not inside this cycle; read
 * {@link dictation.isTranscribing} for that.
 */
export type DictationStatus = 'idle' | 'listening' | 'speaking';

export function createDictation(
	inferenceConnections: ReturnType<typeof createVocabConnections>,
) {
	// The VAD model and wasm are fetched at runtime, so their URL has to carry
	// whatever prefix this build was served under. `base` is empty on Vocab's
	// own deploy and `/apps/<dataId>` inside Epicenter (ADR-0210), which is
	// exactly the difference, and it is the same value `svelte.config.js` set.
	//
	// `base` carries a deprecation hint toward `asset()`, which does not fit:
	// `asset()` resolves one named file in `static/`, and these are a directory
	// of files the build copies in, addressed by prefix. A prefix is what this
	// needs, so a prefix is what it reads.
	const vad = createVadRecorder({ assetBaseUrl: `${base}/vad/` });
	let status = $state<DictationStatus>('idle');
	let inFlightCount = $state(0);
	// Utterances can overlap in transcription (speak phrase B while phrase A is
	// still at the STT endpoint), so deliveries chain behind one promise to land
	// in spoken order. The chain is an ordering device, not an error channel:
	// failures travel in the Result handed to onTranscript.
	let deliveries: Promise<void> = Promise.resolve();

	return {
		/** The one mic state the UI reads. */
		get status(): DictationStatus {
			return status;
		},

		/**
		 * True while any spoken phrase is still transcribing, including after the
		 * session closes (the last phrase finishes and lands after stop).
		 */
		get isTranscribing(): boolean {
			return inFlightCount > 0;
		},

		/**
		 * Open the mic and listen until {@link stop}. Resolves once listening is
		 * established; from then on each detected phrase transcribes and arrives
		 * through `onTranscript`. Calling while a session is open is a no-op.
		 */
		async start({
			onTranscript,
		}: {
			onTranscript: (result: Result<string, TranscribeError>) => void;
		}): Promise<Result<void, VadRecorderError | DeviceStreamError>> {
			if (status !== 'idle') return Ok(undefined);

			const { error: startError } = await vad.startActiveListening({
				// Default device: vocab has no device picker (the package reads no
				// store; the caller passes a deviceId, and vocab refuses to have one).
				// Status writes are gated on an armed session so a callback that fires
				// during the start or stop window cannot flip a closed session's state;
				// the blob itself is still delivered (the user spoke it).
				onSpeechStart: () => {
					if (status !== 'idle') status = 'speaking';
				},
				onVADMisfire: () => {
					if (status !== 'idle') status = 'listening';
				},
				// No level meter in vocab.
				onLevel: () => {},
				onSpeechEnd: (blob) => {
					if (status !== 'idle') status = 'listening';
					inFlightCount += 1;
					deliveries = deliveries
						.then(async () => {
							const transport =
								inferenceConnections.resolveOrHosted(VOCAB_STT_MODEL);
							onTranscript(
								// No language hint: a learner may dictate their question in the
								// language they are studying, so Whisper auto-detects (ADR-0105).
								await transcribe(blob, transport, {
									model: VOCAB_STT_MODEL,
								}),
							);
						})
						// transcribe is Result-typed and never rejects; this only keeps a
						// throwing onTranscript from wedging every later phrase's delivery.
						.catch(() => {})
						.finally(() => {
							inFlightCount -= 1;
						});
				},
			});
			if (startError) return Err(startError);

			status = 'listening';
			return Ok(undefined);
		},

		/**
		 * Close the mic. Phrases already captured still transcribe and deliver;
		 * {@link isTranscribing} stays true until they land.
		 */
		async stop(): Promise<Result<void, VadRecorderError>> {
			status = 'idle';
			const { error: stopError } = await vad.stopActiveListening();
			if (stopError) return Err(stopError);
			return Ok(undefined);
		},
	};
}
