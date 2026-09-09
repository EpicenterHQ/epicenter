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
 * this holds no preferences and reaches for no sync. It receives its
 * hosted transport and uses Vocab's app-local transcription model constant.
 *
 * Dictation explicitly uses the app's hosted transcription transport. Chat
 * connection selection never changes where microphone audio is sent.
 */

import {

	TranscribeError,
} from '@epicenter/client';
import {
	createVadRecorder,
	type DeviceStreamError,
	type VadRecorderError,
} from '@epicenter/recorder';
import { Err, Ok, tryAsync, type Result } from 'wellcrafted/result';
import type OpenAI from 'openai';
import { base } from '$app/paths';
import { VOCAB_STT_MODEL } from '$lib/data';

/**
 * Where the mic is: closed, waiting for speech, or capturing a phrase.
 * Transcription runs beside the session, not inside this cycle; read
 * {@link dictation.isTranscribing} for that.
 */
export type DictationStatus = 'idle' | 'listening' | 'speaking';

export function createDictation(client: OpenAI | null) {
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
	let starting:
		| Promise<Result<void, VadRecorderError | DeviceStreamError | TranscribeError>>
		| undefined;
	let stopping: Promise<Result<void, VadRecorderError>> | undefined;
	let closing: Promise<void> | undefined;
	let closed = false;
	let callbackGeneration = 0;

	function stop(): Promise<Result<void, VadRecorderError>> {
		if (stopping) return stopping;
		stopping = (async () => {
			// The recorder cannot stop an as-yet unacquired microphone. Join its
			// admitted start before tearing down the session it may create.
			await starting;
			const { error } = await vad.stopActiveListening();
			// destroy flushes the final phrase, but an already-running model frame
			// can call back later. Only callbacks admitted before stop settled count.
			callbackGeneration++;
			if (error) return Err(error);
			status = 'idle';
			return Ok(undefined);
		})();
		void stopping
			.finally(() => {
				stopping = undefined;
			})
			.catch(() => {});
		return stopping;
	}

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
		}): Promise<Result<void, VadRecorderError | DeviceStreamError | TranscribeError>> {
			if (closed || stopping || status !== 'idle') return Ok(undefined);
            if (!client) return TranscribeError.TransportFailed({ cause: new Error('This Account does not supply transcription.') });
			if (starting) return starting;
			const generation = ++callbackGeneration;
			starting = (async () => {
				const { error: startError } = await vad.startActiveListening({
					// Default device: vocab has no device picker (the package reads no
					// store; the caller passes a deviceId, and vocab refuses to have one).
					// Status writes are gated on an armed session so a callback that fires
					// during the start or stop window cannot flip a closed session's state;
					// the blob itself is still delivered (the user spoke it).
					onSpeechStart: () => {
						if (generation !== callbackGeneration) return;
						if (status !== 'idle') status = 'speaking';
					},
					onVADMisfire: () => {
						if (generation !== callbackGeneration) return;
						if (status !== 'idle') status = 'listening';
					},
					// No level meter in vocab.
					onLevel: () => {},
					onSpeechEnd: (blob) => {
						if (generation !== callbackGeneration) return;
						if (status !== 'idle') status = 'listening';
						inFlightCount += 1;
						deliveries = deliveries
							.then(async () => {
								onTranscript(
									// No language hint: a learner may dictate their question in the
									// language they are studying, so Whisper auto-detects (ADR-0105).
									await tryAsync({
                                        try: async () => {
                                            const result = await client.audio.transcriptions.create({ file: new File([blob], 'dictation.webm', { type: blob.type }), model: VOCAB_STT_MODEL });
                                            if (typeof result.text !== 'string') throw new Error('Transcription returned no text.');
                                            return result.text;
                                        },
                                        catch: cause => TranscribeError.TransportFailed({ cause }),
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
			})();
			try {
				return await starting;
			} finally {
				starting = undefined;
			}
		},

		/**
		 * Close the mic. Phrases already captured still transcribe and deliver;
		 * {@link isTranscribing} stays true until they land.
		 */
		stop,

		/** End this UI lifetime, including startup and every captured phrase. */
		close(): Promise<void> {
			closed = true;
			closing ??= (async () => {
				const { error } = await stop();
				if (error) throw error;
				await deliveries;
			})();
			return closing;
		},
	};
}
