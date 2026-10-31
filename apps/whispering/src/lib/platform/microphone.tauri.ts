/**
 * The microphone in Whispering's desktop app: the shell's
 * (`tauri-plugin-epicenter-recorder`, ADR-0571), never the WebView's. The
 * shell lists the inputs by name without asking for access, reads one's
 * level without recording, and records `recordings/<id>.wav` into the data
 * folder from the first sample (ADR-0543), named by the root the page
 * opened it at. A quit, a crash, or a closed window keeps the audio up to
 * the cut, and `recover` repairs its header on the next launch.
 *
 * A chosen microphone is asked for by the id the shell listed it under;
 * one that is not connected is refused, never replaced.
 */
import type { RecordingEndedReason } from '@epicenter/recorder';
import {
	listInputs,
	openMeter,
	recoverRecordings,
	startRecording,
} from '@epicenter/recorder/tauri';
import { Err, Ok } from 'wellcrafted/result';
import {
	CaptureError,
	type FolderCaptureDevice,
	type MicrophoneInputs,
} from '../capture.js';
import { captureErrorOf } from '../microphone.js';

/** Where recordings are written, and under which extension. */
const DIRECTORY = 'recordings';
const EXT = 'wav';

const endedError = (reason: RecordingEndedReason, label: string) =>
	reason === 'permissionRevoked'
		? CaptureError.PermissionDenied().error
		: reason === 'deviceDisconnected'
			? CaptureError.InputUnavailable({ label }).error
			: CaptureError.Failed({
					cause: new Error(`The microphone stopped (${reason}).`),
				}).error;

function inputsOf(): MicrophoneInputs {
	return {
		async list() {
			const { data, error } = await listInputs();
			if (error !== null) return Err(captureErrorOf(error));
			return Ok({
				devices: data.map(({ id, name }) => ({ deviceId: id, label: name })),
			});
		},
		async meter(input, signal) {
			const { data: meter, error } = await openMeter({
				input,
				signal,
			});
			if (error !== null) return Err(captureErrorOf(error));
			let level = 0;
			const stopLevels = meter.onLevel((next) => {
				level = next;
			});
			let stopped = false;
			return Ok({
				label: meter.device,
				level: () => (stopped ? 0 : level),
				onEnded(listener) {
					return meter.onEnded((reason) =>
						listener(endedError(reason, meter.device)),
					);
				},
				stop() {
					if (stopped) return;
					stopped = true;
					stopLevels();
					void meter.close();
				},
			});
		},
		// The shell does not announce inputs connected or removed; listing
		// again is always offered.
		onChange: () => () => {},
	};
}

/**
 * The desktop shell's microphone, recording into `root`: the data folder, by
 * the path the shell answered when the page opened it (`rootOf`).
 */
export function createShellMicrophone(root: string): FolderCaptureDevice {
	return {
		keeps: 'folder',
		source: 'microphone',
		label: 'Microphone',
		ext: EXT,
		inputs: inputsOf(),
		async start({ id, input, signal }) {
			const { data: recording, error } = await startRecording({
				root,
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
			const { data, error } = await recoverRecordings({
				root,
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
