/**
 * The real microphone as a capture device: recording from one into
 * Whispering's files, over the inputs the platform lists, allows, and tests.
 *
 * The platform leaf supplies both halves and nothing here chooses between
 * them: the inputs (the WebView's in a browser, the shell's on the desktop)
 * and `@epicenter/recorder`'s one recording API from the entry the leaf
 * imports (`/browser` or `/tauri`). Either way the recording is written into
 * the store as it records, at `recordings/<id>.<ext>`.
 *
 * A chosen microphone is asked for by the exact ID its platform listed it
 * under. When that one cannot be opened, the answer is a refusal: no other
 * microphone is opened in its place.
 */
import type { Client } from '@epicenter/definition/contract';
import type {
	RecorderError,
	RecoverRecordings,
	StartRecording,
} from '@epicenter/recorder';
import { Err, Ok } from 'wellcrafted/result';
import {
	type CaptureDevice,
	CaptureError,
	type CaptureSource,
	type MicrophoneInputs,
} from './capture.js';
import type { Whispering } from './contract.js';

/** Where recordings are written. */
const DIRECTORY = 'recordings';

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
			return CaptureError.Refused({ reason: error.reason }).error;
		case 'Busy':
		case 'NotRecording':
		case 'Failed':
			return CaptureError.Failed({ cause: new Error(error.message) }).error;
	}
}

/** The recorder a microphone device records with: `@epicenter/recorder/browser`'s or `/tauri`'s. */
export type Recorder = {
	readonly startRecording: StartRecording;
	readonly recoverRecordings: RecoverRecordings;
};

export function createMicrophoneDevice({
	device,
	inputs,
	recorder,
	source = 'microphone',
	label = 'Microphone',
}: {
	/** Whispering's files, which every recording is written into. */
	device: Client<Whispering>;
	/** The inputs to choose and test; undefined for a stand-in with none. */
	inputs: MicrophoneInputs | undefined;
	/** Records from a microphone, or from a stand-in for one. */
	recorder: Recorder;
	/** What the recordings it makes are marked as captured from. */
	source?: CaptureSource;
	/** What the person is told this session records from. */
	label?: string;
}): CaptureDevice {
	return {
		source,
		label,
		inputs,
		async start({ id, input, signal }) {
			const { data: recording, error } = await recorder.startRecording({
				device,
				path: `${DIRECTORY}/${id}`,
				input,
				signal,
			});
			if (error !== null) return Err(captureErrorOf(error));
			const startedAt = performance.now();
			return Ok({
				startedAt,
				onEnded: recording.onEnded,
				async stop() {
					const { data, error: stopError } = await recording.stop();
					if (stopError !== null) return Err(captureErrorOf(stopError));
					return Ok({ durationMs: data.durationMs });
				},
			});
		},
		async recover() {
			const { data, error } = await recorder.recoverRecordings({
				device,
				under: DIRECTORY,
			});
			if (error !== null) return Err(captureErrorOf(error));
			return Ok(
				data.map((path) =>
					path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, ''),
				),
			);
		},
	};
}
