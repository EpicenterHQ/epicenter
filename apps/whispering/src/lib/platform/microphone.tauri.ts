/**
 * The microphone in Whispering's desktop app: the shell's
 * (`tauri-plugin-epicenter-recorder`, ADR-0571), never the WebView's. The
 * shell lists the inputs by name without asking for access, reads one's
 * level without recording, and records `recordings/<id>.wav` into the data
 * folder from the first sample (ADR-0543), through `@epicenter/recorder/tauri`,
 * the same recording API a browser build imports from `/browser`. A quit, a
 * crash, or a closed window keeps the audio up to the cut, and `recover`
 * repairs its header on the next launch.
 *
 * A chosen microphone is asked for by the id the shell listed it under;
 * one that is not connected is refused, never replaced.
 */
import type { Client } from '@epicenter/definition/contract';
import type { RecordingEndedReason } from '@epicenter/recorder';
import {
	listInputs,
	openMeter,
	recoverRecordings,
	startRecording,
} from '@epicenter/recorder/tauri';
import { Err, Ok } from 'wellcrafted/result';
import {
	type CaptureDevice,
	CaptureError,
	type MicrophoneInputs,
} from '../capture.js';
import type { Whispering } from '../contract.js';
import { captureErrorOf, createMicrophoneDevice } from '../microphone.js';

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
				label: meter.microphone,
				level: () => (stopped ? 0 : level),
				onEnded(listener) {
					return meter.onEnded((reason) =>
						listener(endedError(reason, meter.microphone)),
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
 * The desktop shell's microphone, recording into `device`: the data folder,
 * whose root the shell answered when the page opened it.
 */
export function createShellMicrophone(
	device: Client<Whispering>,
): CaptureDevice {
	return createMicrophoneDevice({
		device,
		inputs: inputsOf(),
		recorder: { startRecording, recoverRecordings },
	});
}
