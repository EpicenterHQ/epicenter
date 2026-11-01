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
import {
	type Meter,
	RecorderError,
	type RecordingEndedReason,
	type RecoverRecordings,
	type StartRecording,
} from '@epicenter/recorder';
import { Err, Ok } from 'wellcrafted/result';
import type {
	CaptureDevice,
	MicrophoneInputs,
	MicrophoneMeter,
} from './capture.js';
import type { Whispering } from './contract.js';

/** Where recordings are written. */
const DIRECTORY = 'recordings';

/** Why a microphone stopped on its own, said as a refusal to open it would be. */
const endedError = (reason: RecordingEndedReason, label: string) =>
	reason === 'permissionRevoked'
		? RecorderError.PermissionDenied().error
		: reason === 'deviceDisconnected'
			? RecorderError.InputUnavailable({ label }).error
			: RecorderError.Failed({
					cause: new Error(`The microphone stopped (${reason}).`),
				}).error;

/**
 * A recorder's level-only `Meter` (`openMeter` from either entry) as the
 * input test reads it: the latest level on demand, and an ending as the
 * error it means.
 */
export function microphoneMeterOf(meter: Meter): MicrophoneMeter {
	const label = meter.microphone || 'System default';
	let level = 0;
	const stopLevels = meter.onLevel((next) => {
		level = next;
	});
	let stopped = false;
	return {
		label,
		level: () => (stopped ? 0 : level),
		onEnded(listener) {
			return meter.onEnded((reason) => listener(endedError(reason, label)));
		},
		stop() {
			if (stopped) return;
			stopped = true;
			stopLevels();
			void meter.close();
		},
	};
}

/** The recorder a microphone device records with: `@epicenter/recorder/browser`'s or `/tauri`'s. */
export type Recorder = {
	readonly startRecording: StartRecording;
	readonly recoverRecordings: RecoverRecordings;
	/**
	 * Whether a recording reaches its path only whole, once it has stopped:
	 * the desktop shell's, which records outside its path. A cut-off one is
	 * then found only by recovering, and audio at its path is finished. A
	 * browser's is written at its path as it records, where another tab may
	 * still be writing it.
	 */
	readonly placesWhole?: boolean;
};

export function createMicrophoneDevice({
	device,
	inputs,
	recorder,
}: {
	/** Whispering's files, which every recording is written into. */
	device: Client<Whispering>;
	/** The inputs to choose and test. */
	inputs: MicrophoneInputs;
	/** Records from the microphone. */
	recorder: Recorder;
}): CaptureDevice {
	return {
		inputs,
		async start({ id, input, signal }) {
			const { data: recording, error } = await recorder.startRecording({
				device,
				path: `${DIRECTORY}/${id}`,
				input,
				signal,
			});
			if (error !== null) return Err(error);
			const startedAt = performance.now();
			return Ok({
				startedAt,
				onEnded: recording.onEnded,
				async stop() {
					const { data, error: stopError } = await recording.stop();
					if (stopError !== null) return Err(stopError);
					return Ok({ durationMs: data.durationMs });
				},
			});
		},
		async recover(unnamed) {
			// In a browser a cut-off recording is at its path, among `unnamed`.
			if (unnamed.length === 0 && !recorder.placesWhole)
				return Ok({ whole: [], unplaced: [] });
			const { data, error } = await recorder.recoverRecordings({
				device,
				under: DIRECTORY,
			});
			if (error !== null) return Err(error);
			const { unplaced } = data;
			const repaired = data.recovered.map(({ path, durationMs }) => ({
				id: path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, ''),
				durationMs,
			}));
			if (!recorder.placesWhole) return Ok({ whole: repaired, unplaced });
			// Audio at its path is finished: one placed after its page left,
			// or one whose note was never written.
			const answered = new Set(repaired.map(({ id }) => id));
			return Ok({
				whole: [
					...repaired,
					...unnamed
						.filter((id) => !answered.has(id))
						.map((id) => ({ id, durationMs: null })),
				],
				unplaced,
			});
		},
	};
}
