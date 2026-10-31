/**
 * The real microphone as a capture device: recording from one, over the
 * inputs the platform lists, allows, and tests.
 *
 * The platform adapter supplies both halves and nothing here chooses between
 * them. In a browser (`webview-microphone.ts`) the page lists, allows, and
 * tests in the WebView and records with `MediaRecorder`, answering the audio
 * on stop.
 *
 * A chosen microphone is asked for by the exact ID its platform listed it
 * under. When that one cannot be opened, the answer is a refusal: no other
 * microphone is opened in its place.
 */
import type { RecorderError } from '@epicenter/recorder';
import type { StartBrowserRecording } from '@epicenter/recorder/browser';
import { Err, Ok } from 'wellcrafted/result';
import {
	type CaptureDevice,
	CaptureError,
	type CaptureSource,
	type MicrophoneInputs,
} from './capture.js';

/** A recorder's refusal, in the words a capture reports. */
export function captureErrorOf(error: RecorderError): CaptureError {
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
		case 'Busy':
		case 'NotRecording':
		case 'Failed':
			return CaptureError.Failed({ cause: new Error(error.message) }).error;
	}
}

export function createMicrophoneDevice({
	inputs,
	record,
	source = 'microphone',
	label = 'Microphone',
}: {
	/** The inputs to choose and test; undefined for a stand-in with none. */
	inputs: MicrophoneInputs | undefined;
	/** Records with the browser's recorder, or one over a stand-in microphone. */
	record: StartBrowserRecording;
	/** What the recordings it makes are marked as captured from. */
	source?: CaptureSource;
	/** What the person is told this session records from. */
	label?: string;
}): CaptureDevice {
	return {
		source,
		label,
		inputs,
		async start({ input, signal } = {}) {
			const { data: recording, error } = await record({ input, signal });
			if (error !== null) return Err(captureErrorOf(error));
			const startedAt = performance.now();
			return Ok({
				startedAt,
				onEnded: recording.onEnded,
				async stop() {
					const { data: audio, error: stopError } = await recording.stop();
					if (stopError !== null) return Err(captureErrorOf(stopError));
					return Ok({
						bytes: audio.bytes,
						ext: audio.extension,
						durationMs: audio.durationMs,
					});
				},
			});
		},
	};
}
