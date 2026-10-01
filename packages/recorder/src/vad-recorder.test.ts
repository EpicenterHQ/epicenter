/**
 * VAD resource release retains its cleanup capability after failure.
 * The real owner must stop microphone tracks even when graph destruction fails,
 * reject replacement capture, and retry destruction before reporting idle.
 */
import { expect, mock, spyOn, test } from 'bun:test';
import { MicVAD } from '@ricky0123/vad-web';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import * as streams from './device-stream.js';
import { asDeviceIdentifier } from './devices.js';
import { createVadRecorder } from './vad-recorder.js';

test('failed VAD destruction stops tracks but retains ownership until a successful retry', async () => {
	let failing = true;
	const stopTrack = mock();
	const stream = {
		getTracks: () => [{ stop: stopTrack }],
	} as unknown as MediaStream;
	const destroy = mock(async () => {
		if (failing) throw new Error('Audio graph release failed');
	});
	const engine = { start: async () => undefined, destroy } as unknown as MicVAD;
	const create = spyOn(MicVAD, 'new').mockResolvedValue(engine);
	const acquire = spyOn(streams, 'getRecordingStream').mockResolvedValue(
		Ok({
			stream,
			deviceOutcome: {
				outcome: 'success',
				deviceId: asDeviceIdentifier('mic'),
			},
		}),
	);
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
		acquire.mockRestore();
	}
});
