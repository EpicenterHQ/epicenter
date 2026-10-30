/**
 * Desktop microphone tests
 *
 * Drives the desktop microphone device over a stand-in recorder plugin. No
 * WebView is involved: the device lists, tests, and records only through
 * what it is handed. Access is the plugin's to ask for, so a denial here is
 * the plugin's refusal.
 *
 * Key behaviors:
 * - Inputs are listed by the ID and name the shell gives them, and nothing
 *   is said about withheld names
 * - There is no `allow`; denied access opens System Settings at the
 *   microphone pane
 * - A test opens the chosen input by its ID, scales its level for the bar,
 *   reports a microphone that stopped on its own, and closes it on stop
 * - A recording asks for the chosen input by its ID
 */
import { expect, test } from 'bun:test';
import type {
	Meter,
	RecordingEndedReason,
	StartRecordingOptions,
} from '@epicenter/recorder/tauri';
import { RecorderError } from '@epicenter/recorder/tauri';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { CaptureError, CaptureStart } from '../../capture.js';
import { createDesktopMicrophone } from './microphone.js';

const USB = { deviceId: 'coreaudio:usb-uid', label: 'USB Microphone' };

const INTO: CaptureStart = {
	folder: {
		write: async () => Ok(undefined),
	},
	path: 'recordings/a',
};

function shell({ denied = false } = {}) {
	const meters: { input: string | undefined; closed: boolean }[] = [];
	const opened: string[] = [];
	let hear: ((level: number) => void) | undefined;
	let end: ((reason: RecordingEndedReason) => void) | undefined;
	const recordings: StartRecordingOptions[] = [];
	const device = createDesktopMicrophone({
		open: async (url) => {
			opened.push(url);
		},
		recorder: {
			async listInputs() {
				return Ok([
					{
						id: 'coreaudio:built-in',
						name: 'MacBook Microphone',
						isDefault: true,
					},
					{ id: USB.deviceId, name: USB.label, isDefault: false },
				]);
			},
			async openMeter({ input } = {}) {
				if (denied) return RecorderError.PermissionDenied();
				const record = { input: input?.deviceId, closed: false };
				meters.push(record);
				const meter: Meter = {
					device: input?.label ?? 'MacBook Microphone',
					onLevel(listener) {
						hear = listener;
						return () => {};
					},
					onEnded(listener) {
						end = listener;
						return () => {};
					},
					async close() {
						record.closed = true;
					},
				};
				return Ok(meter);
			},
			async startRecording(options) {
				recordings.push(options);
				return RecorderError.Busy({ reason: 'stand-in' });
			},
		},
	});
	if (device.inputs === undefined) throw new Error('A microphone has inputs');
	return {
		device,
		inputs: device.inputs,
		meters,
		opened,
		recordings,
		level: (rms: number) => hear?.(rms),
		end: (reason: RecordingEndedReason) => end?.(reason),
	};
}

test('inputs are listed by the ID and name the shell gives them', async () => {
	const { inputs } = shell();
	expect(expectOk(await inputs.list())).toEqual({
		devices: [
			{ deviceId: 'coreaudio:built-in', label: 'MacBook Microphone' },
			USB,
		],
	});
});

test('there is no allow, and denied access opens the microphone privacy pane', async () => {
	const view = shell({ denied: true });
	expect(view.inputs.allow).toBeUndefined();
	expect(expectErr(await view.inputs.meter(USB)).name).toBe('PermissionDenied');
	expect(view.meters).toEqual([]);
	const openSettings = view.inputs.openSettings;
	if (openSettings === undefined) throw new Error('Epicenter opens settings');
	expectOk(await openSettings());
	expect(view.opened).toEqual([
		'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
	]);
});

test('a test opens the chosen input by its ID, scales its level, and closes it on stop', async () => {
	const view = shell();
	const meter = expectOk(await view.inputs.meter(USB));
	expect(meter.label).toBe('USB Microphone');
	expect(meter.level()).toBe(0);
	view.level(0.25);
	expect(meter.level()).toBeCloseTo(0.75);
	view.level(4);
	expect(meter.level()).toBe(1);
	meter.stop();
	expect(meter.level()).toBe(0);
	expect(view.meters).toEqual([{ input: USB.deviceId, closed: true }]);
});

test('a microphone that stops on its own is reported, and why', async () => {
	const view = shell();
	const meter = expectOk(await view.inputs.meter(USB));
	const heard: CaptureError[] = [];
	meter.onEnded((error) => heard.push(error));
	view.level(0.25);
	view.end('deviceDisconnected');
	view.end('permissionRevoked');
	expect(heard.map((error) => error.name)).toEqual([
		'InputUnavailable',
		'PermissionDenied',
	]);
	expect(meter.level()).toBe(0);
});

test('a recording asks for the chosen input by its ID', async () => {
	const view = shell();
	expect(expectErr(await view.device.start({ ...INTO, input: USB })).name).toBe(
		'Failed',
	);
	expect(view.recordings[0]?.input).toEqual(USB);
});
