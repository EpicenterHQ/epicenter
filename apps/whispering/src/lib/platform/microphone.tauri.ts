/**
 * The microphone in Whispering's desktop app: the shell's
 * (`tauri-plugin-epicenter-recorder`, ADR-0571), never the WebView's. The
 * shell lists the inputs by name without asking for access, reads one's
 * level without recording, and records into the data folder from the first
 * sample, as Opus in WebM placed at `recordings/<id>.webm` when it stops
 * (ADR-0702), through `@epicenter/recorder/tauri`, the same recording API a
 * browser build imports from `/browser`. A quit, a crash, or a closed
 * window keeps the audio up to about its last second, which `recover`
 * finishes and places on the next launch, before anything reads it.
 *
 * A chosen microphone is asked for by the id the shell listed it under;
 * one that is not connected is refused, never replaced.
 */
import type { Client } from '@epicenter/definition/contract';
import {
	listInputs,
	openMeter,
	recoverRecordings,
	startRecording,
} from '@epicenter/recorder/tauri';
import { Err, Ok } from 'wellcrafted/result';
import type { CaptureDevice, MicrophoneInputs } from '../capture.js';
import type { Whispering } from '../contract.js';
import { createMicrophoneDevice, microphoneMeterOf } from '../microphone.js';

function inputsOf(): MicrophoneInputs {
	return {
		async list() {
			const { data, error } = await listInputs();
			if (error !== null) return Err(error);
			return Ok({
				devices: data.map(({ id, name }) => ({ deviceId: id, label: name })),
			});
		},
		async meter(input, signal) {
			const { data: meter, error } = await openMeter({ input, signal });
			if (error !== null) return Err(error);
			return Ok(microphoneMeterOf(meter));
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
		recorder: { startRecording, recoverRecordings, placesWhole: true },
	});
}
