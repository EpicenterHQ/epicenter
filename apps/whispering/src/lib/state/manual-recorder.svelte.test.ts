/**
 * Recorder ownership across deferred native recovery and local startup.
 * Runes are shimmed for imperative assertions; this tests admission and async
 * ownership, not Svelte view invalidation.
 */
import { expect, mock, test } from 'bun:test';
import { generateBlobId } from '@epicenter/blobs';
import { asDeviceIdentifier } from '@epicenter/recorder';
import { Ok, type Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type {
	RecorderError,
	Recording,
	RecordingService,
} from '@epicenter/recorder/recording';

(globalThis as unknown as { $state: unknown }).$state = Object.assign(
	<T>(value: T) => value,
	{ raw: <T>(value: T) => value },
);
const current = mock<() => Promise<Result<Recording | null, RecorderError>>>();
const start = mock<() => Promise<Result<Recording, RecorderError>>>();
const localService: RecordingService = {
	current,
	start,
	enumerateDevices: async () => Ok([]),
};
const accountService: RecordingService = {
	current,
	start,
	enumerateDevices: async () => Ok([]),
};
mock.module('#platform/manual-recorder-config', () => ({
	manualRecorderConfig: {
		resolveStartParams: () => ({ selectedDeviceId: null }),
	},
}));
const { manualRecorder } = await import('./manual-recorder.svelte');

test('pending recovery cannot be replaced by another dataset and local startup remains guarded', async () => {
	const recovery =
		Promise.withResolvers<Result<Recording | null, RecorderError>>();
	current.mockImplementationOnce(() => recovery.promise);
	const oldCancel = manualRecorder.cancelRecording(accountService);
	expect(
		expectErr(await manualRecorder.startRecording(localService)).name,
	).toBe('AlreadyRecording');
	expect(start).not.toHaveBeenCalled();
	recovery.resolve(Ok(null));
	expect(
		expectOk<{ status: 'no-recording' | 'cancelled' }>(await oldCancel).status,
	).toBe('no-recording');

	current.mockImplementationOnce(async () => Ok(null));
	const startup = Promise.withResolvers<Result<Recording, RecorderError>>();
	start.mockImplementationOnce(() => startup.promise);
	const localStart = manualRecorder.startRecording(localService);
	expect(manualRecorder.isStarting).toBe(true);
	expect(
		expectErr(await manualRecorder.startRecording(localService)).name,
	).toBe('AlreadyRecording');
	const cancel = mock(async () => Ok(undefined));
	const recording: Recording = {
		audioBlobId: generateBlobId(),
		account: null,
		device: { outcome: 'success', deviceId: asDeviceIdentifier('mic') },
		endedReason: null,
		stop: async () =>
			Ok({ audioBlobId: recording.audioBlobId, durationMs: 1, byteLength: 2 }),
		cancel,
		onLevel: () => () => {},
		onEnded: () => () => {},
	};
	startup.resolve(Ok(recording));
	expectOk(await localStart);
	expect(manualRecorder.isStarting).toBe(false);
	expect(
		expectErr(await manualRecorder.cancelRecording(accountService)).name,
	).toBe('AlreadyRecording');
	expect(cancel).not.toHaveBeenCalled();
	expectOk<{ status: 'no-recording' | 'cancelled' }>(
		await manualRecorder.cancelRecording(localService),
	);
	expect(cancel).toHaveBeenCalledTimes(1);
});

test('stop and cancel wait for native startup before resolving the capture', async () => {
	for (const action of ['stopRecording', 'cancelRecording'] as const) {
		const startup = Promise.withResolvers<Result<Recording, RecorderError>>();
		start.mockImplementationOnce(() => startup.promise);
		const audioBlobId = generateBlobId();
		const stop = mock(async () =>
			Ok({ audioBlobId, durationMs: 1, byteLength: 2 }),
		);
		const cancel = mock(async () => Ok(undefined));
		const pendingStart = manualRecorder.startRecording(localService);
		let finished = false;
		const pendingEnd = manualRecorder[action](localService).then((result) => {
			finished = true;
			expect(result.error).toBeNull();
		});
		await Promise.resolve();
		expect(finished).toBe(false);
		startup.resolve(
			Ok({
				audioBlobId,
				account: null,
				device: { outcome: 'success', deviceId: asDeviceIdentifier('mic') },
				endedReason: null,
				stop,
				cancel,
				onLevel: () => () => {},
				onEnded: () => () => {},
			}),
		);
		expectOk(await pendingStart);
		await pendingEnd;
		expect(action === 'stopRecording' ? stop : cancel).toHaveBeenCalledTimes(1);
		expect(manualRecorder.state).toBe('IDLE');
	}
});
