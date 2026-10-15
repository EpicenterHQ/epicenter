/**
 * The real microphone: recording from one into the folder, listing the inputs
 * the WebView knows, and reading a level from one without recording.
 *
 * Recording is `@epicenter/recorder`'s: inside the desktop app the shell
 * records and writes the WAV into the folder as it captures, asking for the
 * chosen microphone by the name the WebView lists it under; in a browser the
 * page records with `MediaRecorder`, asking for it by ID, and writes the file
 * on stop. Listing, allowing access, and the level test stay in the WebView.
 *
 * A chosen microphone is asked for by its exact ID. When the WebView cannot
 * open exactly that one, the answer is a refusal: no other microphone is
 * opened in its place. The system default is used only when it is what the
 * person chose.
 *
 * Every stream opened here has one owner that releases it. A request that is
 * withdrawn while the WebView is still answering releases the stream when it
 * arrives, so a late answer never leaves a microphone open.
 *
 * Listing never asks for access. A WebView lists inputs by name only after
 * access was allowed, so `allow` is a separate action the person takes.
 */
import {
	type RecorderError,
	type StartRecording,
	startRecording,
} from '@epicenter/recorder';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type CaptureDevice,
	CaptureError,
	type MicrophoneInputs,
	type MicrophonePreference,
} from './capture.js';

/** The level reading the meter needs from an audio graph. */
type LevelContext = {
	createMediaStreamSource(stream: MediaStream): {
		connect(node: unknown): unknown;
		disconnect(): void;
	};
	createAnalyser(): {
		fftSize: number;
		getFloatTimeDomainData(samples: Float32Array<ArrayBuffer>): void;
	};
	resume(): Promise<void>;
	close(): Promise<void>;
};

/** What of the WebView the microphone uses. Tests supply their own. */
export type MicrophoneEnvironment = {
	readonly mediaDevices:
		| (Pick<MediaDevices, 'getUserMedia' | 'enumerateDevices'> & {
				// Not every WebView announces connected and removed inputs.
				addEventListener?(type: 'devicechange', listener: () => void): void;
				removeEventListener?(type: 'devicechange', listener: () => void): void;
		  })
		| undefined;
	readonly createLevelContext: (() => LevelContext) | undefined;
	/** Records into the folder; `@epicenter/recorder` chooses the host. */
	readonly record: StartRecording;
};

function webViewEnvironment(): MicrophoneEnvironment {
	return {
		mediaDevices:
			typeof navigator === 'undefined' ||
			navigator.mediaDevices?.getUserMedia === undefined
				? undefined
				: navigator.mediaDevices,
		createLevelContext:
			typeof AudioContext === 'undefined'
				? undefined
				: () => new AudioContext(),
		record: startRecording,
	};
}

/** A recorder's refusal, in the words a capture reports. */
function captureErrorOf(error: RecorderError): CaptureError {
	switch (error.name) {
		case 'Unavailable':
			return CaptureError.Unavailable({ reason: error.reason }).error;
		case 'NoInputDevice':
			return CaptureError.Unavailable({ reason: error.reason }).error;
		case 'PermissionDenied':
			return CaptureError.PermissionDenied().error;
		case 'InputUnavailable':
			return CaptureError.InputUnavailable({ label: error.label }).error;
		case 'Cancelled':
			return CaptureError.Cancelled().error;
		case 'Empty':
			return CaptureError.Empty().error;
		case 'Refused':
			return CaptureError.NotSaved({ reason: error.reason }).error;
		case 'Busy':
		case 'NotRecording':
		case 'Failed':
			return CaptureError.Failed({ cause: new Error(error.message) }).error;
	}
}

/**
 * IDs a WebView lists for "whatever the system uses". They are not a
 * microphone to choose by name: the chooser's own System default covers them.
 */
const SYSTEM_ALIASES = new Set(['default', 'communications']);

const release = (stream: MediaStream) => {
	for (const track of stream.getTracks()) track.stop();
};

/** A WebView error's name. `OverconstrainedError` is not a `DOMException` everywhere. */
const nameOf = (cause: unknown) =>
	typeof cause === 'object' && cause !== null && 'name' in cause
		? String(cause.name)
		: '';

/**
 * Open one microphone: exactly `input`, or the system default when none is
 * chosen. The caller owns the stream it is given and must release it.
 */
async function open(
	mediaDevices: MicrophoneEnvironment['mediaDevices'],
	input: MicrophonePreference | undefined,
	signal: AbortSignal | undefined,
): Promise<Result<MediaStream, CaptureError>> {
	if (mediaDevices === undefined)
		return CaptureError.Unavailable({
			reason: 'this window has no microphone access',
		});
	if (signal?.aborted) return CaptureError.Cancelled();
	let stream: MediaStream;
	try {
		stream = await mediaDevices.getUserMedia({
			audio:
				input === undefined ? true : { deviceId: { exact: input.deviceId } },
		});
	} catch (cause) {
		if (signal?.aborted) return CaptureError.Cancelled();
		const name = nameOf(cause);
		if (name === 'NotAllowedError' || name === 'SecurityError')
			return CaptureError.PermissionDenied();
		// An exact ID the WebView cannot satisfy: the microphone is not there.
		if (
			input !== undefined &&
			(name === 'OverconstrainedError' || name === 'NotFoundError')
		)
			return CaptureError.InputUnavailable({ label: input.label });
		if (name === 'NotFoundError')
			return CaptureError.Unavailable({ reason: 'no microphone was found' });
		return CaptureError.Failed({ cause });
	}
	// Withdrawn while the WebView was answering: this stream has no other owner.
	if (signal?.aborted) {
		release(stream);
		return CaptureError.Cancelled();
	}
	if (input !== undefined) {
		// A WebView that reports which microphone it opened must report this one.
		const opened = stream.getAudioTracks()[0]?.getSettings().deviceId;
		if (opened !== undefined && opened !== '' && opened !== input.deviceId) {
			release(stream);
			return CaptureError.InputUnavailable({ label: input.label });
		}
	}
	return Ok(stream);
}

function createInputs(environment: MicrophoneEnvironment): MicrophoneInputs {
	const { mediaDevices } = environment;
	return {
		async list() {
			if (mediaDevices === undefined)
				return CaptureError.Unavailable({
					reason: 'this window has no microphone access',
				});
			let found: MediaDeviceInfo[];
			try {
				found = await mediaDevices.enumerateDevices();
			} catch (cause) {
				return CaptureError.Failed({ cause });
			}
			const inputs = found.filter((device) => device.kind === 'audioinput');
			return Ok({
				devices: inputs
					.filter(
						(device) =>
							device.deviceId !== '' &&
							device.label !== '' &&
							!SYSTEM_ALIASES.has(device.deviceId),
					)
					.map(({ deviceId, label }) => ({ deviceId, label })),
				namesWithheld:
					inputs.length > 0 && inputs.every((device) => device.label === ''),
			});
		},
		async allow(signal) {
			const { data: stream, error: openError } = await open(
				mediaDevices,
				undefined,
				signal,
			);
			if (openError !== null) return Err(openError);
			release(stream);
			return Ok(undefined);
		},
		async meter(input, signal) {
			if (environment.createLevelContext === undefined)
				return CaptureError.Unavailable({
					reason: 'this window cannot measure audio',
				});
			const { data: stream, error: openError } = await open(
				mediaDevices,
				input,
				signal,
			);
			if (openError !== null) return Err(openError);
			let context: LevelContext | undefined;
			let source: ReturnType<LevelContext['createMediaStreamSource']>;
			let analyser: ReturnType<LevelContext['createAnalyser']>;
			try {
				context = environment.createLevelContext();
				source = context.createMediaStreamSource(stream);
				analyser = context.createAnalyser();
				analyser.fftSize = 1024;
				// The analyser is the end of the graph: nothing is played or recorded.
				source.connect(analyser);
				void context.resume().catch(() => {});
			} catch (cause) {
				release(stream);
				void context?.close().catch(() => {});
				return CaptureError.Failed({ cause });
			}
			const samples = new Float32Array(analyser.fftSize);
			const graph = context;
			let stopped = false;
			return Ok({
				label:
					stream.getAudioTracks()[0]?.label || input?.label || 'System default',
				level() {
					if (stopped) return 0;
					analyser.getFloatTimeDomainData(samples);
					let squares = 0;
					for (const sample of samples) squares += sample * sample;
					// Speech sits low on a linear scale; the root spreads it over the bar.
					return Math.min(
						1,
						Math.sqrt(Math.sqrt(squares / samples.length)) * 1.5,
					);
				},
				stop() {
					if (stopped) return;
					stopped = true;
					source.disconnect();
					release(stream);
					void graph.close().catch(() => {});
				},
			});
		},
		onChange(listener) {
			if (mediaDevices?.addEventListener === undefined) return () => {};
			mediaDevices.addEventListener('devicechange', listener);
			return () => mediaDevices.removeEventListener?.('devicechange', listener);
		},
	};
}

export function createMicrophoneDevice(
	environment: MicrophoneEnvironment = webViewEnvironment(),
): CaptureDevice {
	return {
		source: 'microphone',
		label: 'Microphone',
		inputs: createInputs(environment),
		async start({ folder, path, input, signal }) {
			const { data: recording, error } = await environment.record({
				folder,
				path,
				input,
				signal,
			});
			if (error !== null) return Err(captureErrorOf(error));
			const startedAt = performance.now();
			return Ok({
				audioPath: recording.path,
				startedAt,
				async stop() {
					const { data: stopped, error: stopError } = await recording.stop();
					if (stopError !== null) return Err(captureErrorOf(stopError));
					return Ok({ durationMs: stopped.durationMs });
				},
				async cancel() {
					await recording.cancel();
				},
			});
		},
	};
}
