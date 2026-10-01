/**
 * Push-to-Talk Lifecycle Tests
 *
 * Verifies that push-to-talk owns and stops only the recording started by its
 * current press, including when release or app teardown races recorder startup.
 *
 * Key behaviors:
 * - Release during startup stops the recording as soon as startup completes
 * - App teardown drains an in-flight or active recording
 * - Teardown from another app cannot retire the current session
 */
import { expect, mock, test } from 'bun:test';
import { type BlobId, generateBlobId } from '@epicenter/blobs';
import type { WhisperingApp } from '$lib/whispering/app';

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

test('release during startup stops the recording when startup completes', async () => {
	const recordingId = generateBlobId();
	let resolveStart!: () => void;
	startManualRecording.mockImplementationOnce(async () => {
		recorderIsStarting = true;
		await new Promise<void>((resolve) => {
			resolveStart = resolve;
		});
		recorderIsStarting = false;
		recorderState = 'RECORDING';
		return recordingId;
	});

	const start = pushToTalk.start(app);
	const release = pushToTalk.stop(app);
	resolveStart();
	await Promise.all([start, release]);

	expect(stopManualRecordingById).toHaveBeenLastCalledWith(app, recordingId);
	recorderState = 'STOPPED';
});

test('dispose stops an active push-to-talk recording before app teardown', async () => {
	const recordingId = generateBlobId();
	startManualRecording.mockImplementationOnce(async () => recordingId);

	await pushToTalk.start(app);
	recorderState = 'RECORDING';
	await pushToTalk.dispose(app);

	expect(stopManualRecordingById).toHaveBeenLastCalledWith(app, recordingId);
	recorderState = 'STOPPED';
});

test('dispose cannot retire another app session', async () => {
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
