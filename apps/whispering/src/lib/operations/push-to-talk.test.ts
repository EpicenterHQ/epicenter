import { expect, mock, test } from 'bun:test';
import type { RecordingSessionId } from '$lib/services/recorder/contract';
import type { WhisperingApp } from '$lib/whispering/app';

let recorderState: 'STOPPED' | 'RECORDING' = 'STOPPED';
let recorderIsStarting = false;
const startManualRecording =
	mock<(app: WhisperingApp) => Promise<RecordingSessionId | null>>();
const stopManualRecordingSession = mock(async () => {});

const sessionId = (value: string) => value as RecordingSessionId;

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
	stopManualRecordingSession,
}));

const { pushToTalk } = await import('./push-to-talk');
const app = {} as WhisperingApp;

test('dispose stops an active push-to-talk recording before app teardown', async () => {
	const recordingSessionId = sessionId('session-1');
	startManualRecording.mockImplementationOnce(async () => recordingSessionId);

	await pushToTalk.start(app);
	recorderState = 'RECORDING';
	await pushToTalk.dispose(app);

	expect(stopManualRecordingSession).toHaveBeenLastCalledWith(
		app,
		recordingSessionId,
	);
	recorderState = 'STOPPED';
});

test('dispose cannot retire another app session', async () => {
	const recordingSessionId = sessionId('session-2');
	const otherApp = {} as WhisperingApp;
	const stopsBefore = stopManualRecordingSession.mock.calls.length;
	startManualRecording.mockImplementationOnce(async () => recordingSessionId);

	await pushToTalk.start(app);
	recorderState = 'RECORDING';
	await pushToTalk.dispose(otherApp);

	expect(stopManualRecordingSession).toHaveBeenCalledTimes(stopsBefore);
	await pushToTalk.dispose(app);
	recorderState = 'STOPPED';
});

test('dispose invalidates and drains a recording start already in flight', async () => {
	const recordingSessionId = sessionId('session-3');
	let resolveStart!: (id: RecordingSessionId) => void;
	startManualRecording.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				resolveStart = resolve;
			}),
	);
	recorderIsStarting = true;

	const start = pushToTalk.start(app);
	const disposal = pushToTalk.dispose(app);
	resolveStart(recordingSessionId);
	await Promise.all([start, disposal]);

	expect(stopManualRecordingSession).toHaveBeenLastCalledWith(
		app,
		recordingSessionId,
	);
	recorderIsStarting = false;
});
