import { MicVAD, utils } from '@ricky0123/vad-web';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { openMicrophone, release } from './microphone.js';
import { RecorderError, type RecordingInput } from './recording.js';

const VadRecorderError = defineErrors({
	AlreadyActive: () => ({
		message: 'Stop the current session before starting a new one.',
	}),
	InitializeFailed: ({ cause }: { cause: unknown }) => ({
		message:
			'Voice activity detection could not be started. Your microphone may be in use by another application.',
		cause,
	}),
	StartFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to start Voice Activity Detector. ${extractErrorMessage(cause)}`,
		cause,
	}),
	StopFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to stop Voice Activity Detector. ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type VadRecorderError = InferErrors<typeof VadRecorderError>;

/**
 * Active VAD session, or null when idle. Holds the underlying MicVAD and the
 * MediaStream it borrows so the recorder can tear both down on stop.
 */
type VadSession = {
	vad: MicVAD;
	stream: MediaStream;
};

/**
 * Root-mean-square amplitude of one audio frame (samples in -1..1), a cheap
 * proxy for "how loud is the mic right now". Fed to a level meter. Computed from
 * the frame the VAD already hands us, so there is no second audio graph.
 */
function computeFrameRms(frame: Float32Array): number {
	if (frame.length === 0) return 0;
	let sumOfSquares = 0;
	for (const sample of frame) sumOfSquares += sample * sample;
	return Math.sqrt(sumOfSquares / frame.length);
}

export type StartActiveListeningOptions = {
	/**
	 * The microphone to listen on, or undefined for the system default. When
	 * that exact microphone cannot be opened, listening is refused; no other
	 * microphone is used in its place. The package reads no settings store; the
	 * caller passes the input it chose.
	 */
	input?: RecordingInput;
	onSpeechStart: () => void;
	onSpeechEnd: (blob: Blob) => void;
	onVADMisfire: () => void;
	/**
	 * Called after each processed frame with the frame's RMS amplitude. Drives a
	 * live level meter.
	 */
	onLevel: (level: number) => void;
};

export type VadRecorder = {
	/**
	 * Start voice activity detection. The speech callbacks fire for the rest of
	 * the session; the caller mirrors them into whatever reactive state it
	 * keeps.
	 */
	startActiveListening(
		options: StartActiveListeningOptions,
	): Promise<Result<undefined, VadRecorderError | RecorderError>>;
	/**
	 * Stop voice activity detection and clean up the VAD and its stream.
	 */
	stopActiveListening(): Promise<
		Result<{ status: 'idle' | 'stopped' }, VadRecorderError>
	>;
};

/**
 * Create a Voice Activity Detection recorder backed by `@ricky0123/vad-web`
 * (Silero v5). This is a callback core with no framework reactivity: it emits
 * speech events through callbacks and reads no app store. A consuming app that
 * needs reactive state wraps it in a thin runes layer.
 *
 * Usage:
 * - Start listening: `await vad.startActiveListening({ input, onSpeechStart, onSpeechEnd, onVADMisfire, onLevel })`
 * - Stop listening: `await vad.stopActiveListening()`
 */
export function createVadRecorder({
	assetBaseUrl = '/vad/',
}: {
	/** Base path for the served ONNX model and wasm assets (see `@epicenter/recorder/vad-assets`). */
	assetBaseUrl?: string;
} = {}): VadRecorder {
	let _session: VadSession | null = null;
	// `_session` is assigned after async setup, so `_starting` closes the
	// duplicate-start window before a live session exists.
	let _starting = false;

	return {
		async startActiveListening({
			input,
			onSpeechStart,
			onSpeechEnd,
			onVADMisfire,
			onLevel,
		}) {
			if (_session || _starting) return VadRecorderError.AlreadyActive();
			_starting = true;

			try {
				if (navigator.mediaDevices?.getUserMedia === undefined)
					return RecorderError.Unavailable({
						reason: 'this window has no microphone access',
					});
				const { data: stream, error: openError } = await openMicrophone(
					navigator.mediaDevices,
					input,
					undefined,
				);
				if (openError !== null) return Err(openError);

				// Create VAD with the opened stream
				const { data: newVad, error: initializeVadError } = await tryAsync({
					try: () =>
						MicVAD.new({
							// The recorder owns the stream lifecycle: it is opened via
							// openMicrophone and released by stopActiveListening's
							// release below. MicVAD only borrows it, so
							// pause is a no-op and resume hands back the same live stream.
							// (Resume is never reached today: this starts once and
							// destroys on stop, but keeping it live keeps the three stream
							// hooks mutually consistent rather than handing back a stopped
							// stream.)
							getStream: async () => stream,
							pauseStream: async () => {},
							resumeStream: async () => stream,
							startOnLoad: false,
							submitUserSpeechOnPause: true,
							onSpeechStart,
							onSpeechEnd: (audio) => {
								onSpeechEnd(
									new Blob([utils.encodeWAV(audio)], { type: 'audio/wav' }),
								);
							},
							onVADMisfire,
							onFrameProcessed: (_probabilities, frame) => {
								onLevel(computeFrameRms(frame));
							},
							model: 'v5',
							baseAssetPath: assetBaseUrl,
							// vad-web sets `ort.env.wasm.wasmPaths` to this base path before
							// calling ortConfig, so the default onnxruntime-web build resolves
							// <assetBaseUrl>ort-wasm-simd-threaded.{mjs,wasm} on its own.
							onnxWASMBasePath: assetBaseUrl,
							ortConfig: (ort) => {
								ort.env.logLevel = 'error';
							},
						}),
					catch: (error) => VadRecorderError.InitializeFailed({ cause: error }),
				});

				if (initializeVadError) {
					// Clean up stream if VAD initialization fails
					release(stream);
					return Err(initializeVadError);
				}

				// Start listening
				const { error: startError } = await tryAsync({
					try: async () => newVad.start(),
					catch: (error) => VadRecorderError.StartFailed({ cause: error }),
				});

				if (startError) {
					// Clean up everything on start error
					await tryAsync({
						try: async () => newVad.destroy(),
						catch: () => Ok(undefined),
					});
					release(stream);
					return Err(startError);
				}

				_session = { vad: newVad, stream };
				return Ok(undefined);
			} finally {
				_starting = false;
			}
		},

		async stopActiveListening() {
			if (!_session) return Ok({ status: 'idle' as const });

			const { vad, stream } = _session;
			const { error: destroyError } = await tryAsync({
				try: async () => {
					try {
						await vad.destroy();
					} finally {
						release(stream);
					}
				},
				catch: (error) => VadRecorderError.StopFailed({ cause: error }),
			});

			// A failed destroy still owns resources. Keep its cleanup capability
			// so retry cannot report idle while an audio graph remains held.
			if (destroyError) return Err(destroyError);
			_session = null;
			return Ok({ status: 'stopped' as const });
		},
	};
}
