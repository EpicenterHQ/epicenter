/**
 * The microphone in a browser tab: listing the inputs the WebView knows,
 * and, through `@epicenter/recorder/browser`, allowing access, reading a
 * level from one without recording, and recording, which asks for the
 * chosen microphone by ID and appends each piece to the recording's file in
 * this browser's files as it arrives (decision 84). The recorder opens
 * every microphone here, so each is asked for the same way and released by
 * the one that opened it.
 *
 * A chosen microphone is asked for by its exact ID. When the WebView cannot
 * open exactly that one, the answer is a refusal: no other microphone is
 * opened in its place. The system default is used only when it is what the
 * person chose.
 *
 * Listing never asks for access. A WebView lists inputs by name only after
 * access was allowed, so `allow` is a separate action the person takes.
 */
import type { Client } from '@epicenter/definition/contract';
import {
	allowMicrophone,
	openMeter,
	RecorderError,
	recoverRecordings,
	startRecording,
} from '@epicenter/recorder/browser';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import type { CaptureDevice, MicrophoneInputs } from './capture.js';
import type { Whispering } from './contract.js';
import { createMicrophoneDevice, microphoneMeterOf } from './microphone.js';

/**
 * IDs a WebView lists for "whatever the system uses". They are not a
 * microphone to choose by name: the chooser's own System default covers them.
 */
const SYSTEM_ALIASES = new Set(['default', 'communications']);

/** The WebView's media devices, or undefined in a window with no microphone access. */
const mediaDevices = () =>
	typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;

const inputs: MicrophoneInputs = {
	async list() {
		const devices = mediaDevices();
		if (devices?.enumerateDevices === undefined)
			return RecorderError.Unavailable({
				reason: 'this window has no microphone access',
			});
		const { data: found, error } = await tryAsync({
			try: () => devices.enumerateDevices(),
			catch: (cause) => RecorderError.Failed({ cause }),
		});
		if (error !== null) return Err(error);
		const audioInputs = found.filter((device) => device.kind === 'audioinput');
		return Ok({
			devices: audioInputs
				.filter(
					(device) =>
						device.deviceId !== '' &&
						device.label !== '' &&
						!SYSTEM_ALIASES.has(device.deviceId),
				)
				.map(({ deviceId, label }) => ({ deviceId, label })),
			namesWithheld:
				audioInputs.length > 0 &&
				audioInputs.every((device) => device.label === ''),
		});
	},
	allow: (signal) => allowMicrophone({ signal }),
	async meter(input, signal) {
		const { data: meter, error } = await openMeter({ input, signal });
		if (error !== null) return Err(error);
		return Ok(microphoneMeterOf(meter));
	},
	onChange(listener) {
		// Not every WebView announces connected and removed inputs.
		const devices = mediaDevices();
		if (devices?.addEventListener === undefined) return () => {};
		devices.addEventListener('devicechange', listener);
		return () => devices.removeEventListener('devicechange', listener);
	},
};

/** The WebView's microphone, recording into `device`: this browser's files. */
export function createWebViewMicrophone(
	device: Client<Whispering>,
): CaptureDevice {
	return createMicrophoneDevice({
		device,
		inputs,
		recorder: { startRecording, recoverRecordings },
	});
}
