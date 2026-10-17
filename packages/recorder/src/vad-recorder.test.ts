/**
 * Voice activity detection opens its microphone the way recording does, and
 * keeps its cleanup capability after a failed release: it must stop microphone
 * tracks even when graph destruction fails, reject replacement capture, and
 * retry destruction before reporting idle.
 */
import { expect, mock, spyOn, test } from 'bun:test';
import { MicVAD } from '@ricky0123/vad-web';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createVadRecorder } from './vad-recorder.js';

/** Give the page a microphone that answers `getUserMedia`, until restored. */
function microphone(
	answer: MediaStream | MediaDevices['getUserMedia'],
): () => void {
	const previous = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
	const getUserMedia =
		typeof answer === 'function' ? answer : async () => answer;
	Object.defineProperty(navigator, 'mediaDevices', {
		configurable: true,
		value: { getUserMedia },
	});
	return () => {
		if (previous) Object.defineProperty(navigator, 'mediaDevices', previous);
		else Reflect.deleteProperty(navigator, 'mediaDevices');
	};
}

test('failed VAD destruction stops tracks but retains ownership until a successful retry', async () => {
	let failing = true;
	const stopTrack = mock();
	const stream = {
		getTracks: () => [{ stop: stopTrack }],
		getAudioTracks: () => [],
	} as unknown as MediaStream;
	const destroy = mock(async () => {
		if (failing) throw new Error('Audio graph release failed');
	});
	const engine = { start: async () => undefined, destroy } as unknown as MicVAD;
	const create = spyOn(MicVAD, 'new').mockResolvedValue(engine);
	const restoreMicrophone = microphone(stream);
	try {
		const recorder = createVadRecorder();
		const callbacks = {
			onSpeechStart() {},
			onSpeechEnd() {},
			onVADMisfire() {},
			onLevel() {},
		};
		expectOk(await recorder.startActiveListening(callbacks));
		expect(expectErr(await recorder.stopActiveListening()).name).toBe(
			'StopFailed',
		);
		expect(stopTrack).toHaveBeenCalledTimes(1);
		expect(expectErr(await recorder.startActiveListening(callbacks)).name).toBe(
			'AlreadyActive',
		);
		failing = false;
		expect(expectOk(await recorder.stopActiveListening()).status).toBe(
			'stopped',
		);
		expect(destroy).toHaveBeenCalledTimes(2);
		expect(expectOk(await recorder.stopActiveListening()).status).toBe('idle');
	} finally {
		create.mockRestore();
		restoreMicrophone();
	}
});

test('a chosen microphone the browser cannot open is refused, and no other is opened', async () => {
	const asked: MediaStreamConstraints[] = [];
	const restoreMicrophone = microphone(async (constraints) => {
		asked.push(constraints ?? {});
		throw Object.assign(new Error('no such device'), {
			name: 'OverconstrainedError',
		});
	});
	const create = spyOn(MicVAD, 'new');
	try {
		const error = expectErr(
			await createVadRecorder().startActiveListening({
				input: { deviceId: 'usb-1', label: 'USB Mic' },
				onSpeechStart() {},
				onSpeechEnd() {},
				onVADMisfire() {},
				onLevel() {},
			}),
		);
		expect(error.name).toBe('InputUnavailable');
		expect(asked).toEqual([{ audio: { deviceId: { exact: 'usb-1' } } }]);
		expect(create).not.toHaveBeenCalled();
	} finally {
		create.mockRestore();
		restoreMicrophone();
	}
});
