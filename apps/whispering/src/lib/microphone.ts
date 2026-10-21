/**
 * The real microphone as a capture device: recording from one into the
 * folder, over the inputs the platform lists, allows, and tests.
 *
 * Each platform adapter supplies both halves and nothing here chooses between them:
 *
 * - In Epicenter (`platform/desktop/microphone.ts`) Rust owns the
 *   microphone. The shell lists the inputs, reads a level, asks the system
 *   for access, and records the WAV into the folder as it captures; the page
 *   opens no microphone of its own (ADR-0571).
 * - In a browser (`webview-microphone.ts`) the page lists, allows, and tests
 *   in the WebView and records with `MediaRecorder`, writing the file on stop.
 *
 * A chosen microphone is asked for by the exact ID its platform listed it
 * under. When that one cannot be opened, the answer is a refusal: no other
 * microphone is opened in its place.
 */
import type { RecorderError, StartRecording } from '@epicenter/recorder';
import { Err, Ok } from 'wellcrafted/result';
import {
	type CaptureDevice,
	CaptureError,
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
			return CaptureError.NotSaved({ reason: error.reason }).error;
		case 'Busy':
		case 'NotRecording':
		case 'Failed':
			return CaptureError.Failed({ cause: new Error(error.message) }).error;
	}
}

export function createMicrophoneDevice({
	inputs,
	record,
}: {
	inputs: MicrophoneInputs;
	/** Records into the folder: the shell's recorder, or the browser's. */
	record: StartRecording;
}): CaptureDevice {
	return {
		source: 'microphone',
		label: 'Microphone',
		inputs,
		async start({ folder, path, input, signal }) {
			const { data: recording, error } = await record({
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
				onEnded: recording.onEnded,
				async stop() {
					const { data: stopped, error: stopError } = await recording.stop();
					if (stopError !== null) return Err(captureErrorOf(stopError));
					return Ok({ durationMs: stopped.durationMs });
				},
				async cancel() {
					const { error: cancelError } = await recording.cancel();
					return cancelError === null
						? Ok(undefined)
						: Err(captureErrorOf(cancelError));
				},
			});
		},
	};
}
