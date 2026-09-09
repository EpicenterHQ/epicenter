/** Verifies push-to-talk resolves only its owned recording and drains pending startup. */
import { expect, mock, test } from 'bun:test';
import { type BlobId, generateBlobId } from '@epicenter/blobs';
import type { WhisperingApp } from '$lib/whispering/app';

let recorderState: 'STOPPED' | 'RECORDING' = 'STOPPED';
let recorderIsStarting = false;
const start = mock<() => Promise<BlobId | null>>();
const stop = mock(async () => {});

mock.module('$lib/report', () => ({
	log: { warn: mock() },
	report: { info: mock() },
}));
const recording = {
	start,
	stop,
	get state() {
		return recorderState;
	},
	get isStarting() {
		return recorderIsStarting;
	},
};
const { pushToTalk } = await import('./push-to-talk');
const app = { recording } as unknown as WhisperingApp;

test('dispose stops an active push-to-talk recording before app teardown', async () => {
	const recordingId = generateBlobId();
	start.mockImplementationOnce(async () => recordingId);

	await pushToTalk.start(app);
	recorderState = 'RECORDING';
	await pushToTalk.dispose(app);

	expect(stop).toHaveBeenLastCalledWith(recordingId);
	recorderState = 'STOPPED';
});

test('dispose cannot retire another app session', async () => {
	const recordingId = generateBlobId();
	const otherApp = {} as WhisperingApp;
	const stopsBefore = stop.mock.calls.length;
	start.mockImplementationOnce(async () => recordingId);

	await pushToTalk.start(app);
	recorderState = 'RECORDING';
	await pushToTalk.dispose(otherApp);

	expect(stop).toHaveBeenCalledTimes(stopsBefore);
	await pushToTalk.dispose(app);
	recorderState = 'STOPPED';
});

test('dispose invalidates and drains a recording start already in flight', async () => {
	const recordingId = generateBlobId();
	let resolveStart!: (id: BlobId) => void;
	start.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				resolveStart = resolve;
			}),
	);
	recorderIsStarting = true;

	const starting = pushToTalk.start(app);
	const disposal = pushToTalk.dispose(app);
	resolveStart(recordingId);
	await Promise.all([starting, disposal]);

	expect(stop).toHaveBeenLastCalledWith(recordingId);
	recorderIsStarting = false;
});
