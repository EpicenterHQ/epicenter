import { expect, mock, test } from 'bun:test';
import { type BlobId, generateBlobId } from '@epicenter/blobs';
import type { WhisperingApplication as WhisperingApp } from '$lib/whispering/application';

let recorderState: 'STOPPED' | 'RECORDING' = 'STOPPED';
let recorderIsStarting = false;
const startManualRecording =
	mock<(app: WhisperingApp) => Promise<BlobId | null>>();
const stopManualRecordingById = mock(async () => {});

mock.module('$lib/report', () => ({
	log: { warn: mock() },
	report: { info: mock() },
}));
mock.module('$lib/state/manual-recorder.svelte', () => ({
	manualRecorder: {
		get state() {
			return recorderState;
		},
		get isStarting() {
			return recorderIsStarting;
		},
	},
}));
mock.module('./recording', () => ({
	startManualRecording,
	stopManualRecordingById,
}));

const { pushToTalk } = await import('./push-to-talk');
const app = {} as WhisperingApp;

test('dispose stops an active push-to-talk recording before app teardown', async () => {
	const recordingId = generateBlobId();
	startManualRecording.mockImplementationOnce(async () => recordingId);

	await pushToTalk.start(app);
	recorderState = 'RECORDING';
	await pushToTalk.dispose(app);

	expect(stopManualRecordingById).toHaveBeenLastCalledWith(app, recordingId);
	recorderState = 'STOPPED';
});

test('dispose cannot retire another application session', async () => {
	const recordingId = generateBlobId();
	const otherApp = {} as WhisperingApp;
	const stopsBefore = stopManualRecordingById.mock.calls.length;
	startManualRecording.mockImplementationOnce(async () => recordingId);

	await pushToTalk.start(app);
	recorderState = 'RECORDING';
	await pushToTalk.dispose(otherApp);

	expect(stopManualRecordingById).toHaveBeenCalledTimes(stopsBefore);
	await pushToTalk.dispose(app);
	recorderState = 'STOPPED';
});

test('dispose invalidates and drains a recording start already in flight', async () => {
	const recordingId = generateBlobId();
	let resolveStart!: (id: BlobId) => void;
	startManualRecording.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				resolveStart = resolve;
			}),
	);
	recorderIsStarting = true;

	const start = pushToTalk.start(app);
	const disposal = pushToTalk.dispose(app);
	resolveStart(recordingId);
	await Promise.all([start, disposal]);

	expect(stopManualRecordingById).toHaveBeenLastCalledWith(app, recordingId);
	recorderIsStarting = false;
});
