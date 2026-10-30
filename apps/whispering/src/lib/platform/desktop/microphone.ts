/**
 * The microphone inside Epicenter, where Rust owns it (ADR-0571).
 *
 * The page never opens a microphone: the recorder plugin lists the inputs,
 * reads one's level for the test, and records the WAV into the folder, each
 * by the ID the plugin lists the input under. The plugin asks macOS for
 * microphone access before it opens anything, for every caller, so a denial
 * arrives here as `PermissionDenied` and nothing was opened. Nothing here
 * falls back to the WebView.
 *
 * There is no `allow`: the shell lists names without access, and asks for
 * access itself. Access that was denied is allowed again in System Settings,
 * which `openSettings` opens at the microphone pane through the opener.
 */
import {
	listInputs,
	openMeter,
	type RecordingEndedReason,
	type StartRecording,
	startRecording,
} from '@epicenter/recorder/tauri';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Err, Ok } from 'wellcrafted/result';
import { type CaptureDevice, CaptureError } from '../../capture.js';
import { captureErrorOf, createMicrophoneDevice } from '../../microphone.js';

/** The recorder plugin, as `@epicenter/recorder/tauri` reaches it; injected for tests. */
export type DesktopRecorder = {
	listInputs: typeof listInputs;
	openMeter: typeof openMeter;
	startRecording: StartRecording;
};

/** System Settings, at Privacy and Security, Microphone. */
const MICROPHONE_SETTINGS =
	'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';

/** Speech sits low on a linear scale; the root spreads it over the bar. */
const meterLevel = (rms: number) => Math.min(1, Math.sqrt(rms) * 1.5);

/** Why a meter's microphone stopped on its own, in the words a capture reports. */
function endedError(reason: RecordingEndedReason, label: string): CaptureError {
	switch (reason) {
		case 'permissionRevoked':
			return CaptureError.PermissionDenied().error;
		case 'deviceDisconnected':
			return CaptureError.InputUnavailable({ label }).error;
		case 'streamFailed':
		case 'storageFailed':
			return CaptureError.Failed({
				cause: new Error('the microphone stopped on its own'),
			}).error;
	}
}

export function createDesktopMicrophone({
	recorder = { listInputs, openMeter, startRecording },
	open = openUrl,
}: {
	recorder?: DesktopRecorder;
	/** Opens a URL with the system; injected for tests. */
	open?: (url: string) => Promise<void>;
} = {}): CaptureDevice {
	return createMicrophoneDevice({
		inputs: {
			async list() {
				const { data: inputs, error } = await recorder.listInputs();
				if (error !== null) return Err(captureErrorOf(error));
				return Ok({
					devices: inputs.map(({ id, name }) => ({
						deviceId: id,
						label: name,
					})),
				});
			},
			async meter(input, signal) {
				const { data: meter, error } = await recorder.openMeter({
					input,
					signal,
				});
				if (error !== null) return Err(captureErrorOf(error));
				let level = 0;
				let stopped = false;
				meter.onLevel((rms) => {
					level = meterLevel(rms);
				});
				return Ok({
					label: meter.device,
					level: () => (stopped ? 0 : level),
					onEnded(listener) {
						return meter.onEnded((reason) => {
							level = 0;
							if (!stopped) listener(endedError(reason, meter.device));
						});
					},
					stop() {
						if (stopped) return;
						stopped = true;
						void meter.close();
					},
				});
			},
			async openSettings() {
				try {
					await open(MICROPHONE_SETTINGS);
					return Ok(undefined);
				} catch (cause) {
					return CaptureError.Failed({ cause });
				}
			},
			// The shell does not announce connected or removed inputs; listing
			// again is always offered.
			onChange: () => () => {},
		},
		record: recorder.startRecording,
	});
}
