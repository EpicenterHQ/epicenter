/**
 * Recording Pipeline Auto-Upload Tests
 *
 * Verifies the intentionally small automatic policy at the row-creation seam.
 *
 * Key behaviors:
 * - An enabled setting kicks the reconciler after the row exists
 * - A disabled setting performs no upload and no kick
 * - Upload remains best-effort and does not block transcription
 * - History failure warns only after usable text is delivered
 * - Credit failures offer account management without delivering or resuming work
 */
import { afterEach, expect, mock, test } from 'bun:test';
import { createDeparture } from '@epicenter/app-shell/departure';
import type { AuthState } from '@epicenter/auth';
import { Err, Ok } from 'wellcrafted/result';
import type { RecordingId } from '$lib/data';

let autoUpload = true;
let remoteAvailable = true;
let creationError: { name: string; message: string } | null = null;
let transcriptionError: { name: string; message: string } | null = null;
const markFailed = mock();
const markTranscribing = mock();
let willPolish = false;
let lifetime = new AbortController();
let finishPolish: (() => Promise<void>) | undefined;
let finishTranscription: (() => Promise<void>) | undefined;
let recordingEnabled = true;
let createdRows = 0;
mock.module('$lib/application', () => ({
	getApp: () => ({ signal: lifetime.signal }),
}));
const uploadAudio = mock(async () => Ok(undefined));
const kick = mock(async () => ({
	uploaded: 0,
	absent: 0,
	failed: 0,
	aborted: false,
}));
const deliverTranscriptionResult = mock(async () => ({
	outcome: { reach: 'output' } as const,
	notice: { title: 'done' },
}));
const reportInfo = mock();
const reportError = mock();
const rejectLoading = mock();
let historyError: { name: string; message: string } | null = null;
let polishedHistoryError: { name: string; message: string } | null = null;
const saveRecordingHistory = mock(async () =>
	polishedHistoryError === null ? Ok(undefined) : Err(polishedHistoryError),
);

mock.module('$lib/operations/delivery', () => ({
	deliverTranscriptionResult,
}));
mock.module('$lib/operations/run-polish', () => ({
	polishWillRun: () => willPolish,
	runPolish: async ({ input }: { input: string }) => {
		await finishPolish?.();
		return Ok(willPolish ? 'polished transcript' : input);
	},
}));
mock.module('$lib/operations/sound', () => ({
	playSoundIfEnabled: mock(async () => Ok(undefined)),
}));
mock.module('$lib/operations/transcribe', () => ({
	transcribeAndPersist: async () => {
		await finishTranscription?.();
		return transcriptionError !== null
			? Err(transcriptionError)
			: Ok({
					text: 'transcript',
					history: historyError === null ? Ok(undefined) : Err(historyError),
				});
	},
}));
mock.module('$lib/operations/transcription-history', () => ({
	saveRecordingHistory,
}));
mock.module('$lib/report', () => ({
	log: { warn: mock() },
	report: {
		info: reportInfo,
		error: reportError,
		loading: () => ({ resolve: mock(), reject: rejectLoading }),
	},
}));
mock.module('$lib/state/dictation-lifecycle.svelte', () => ({
	dictationLifecycle: {
		markTranscribing,
		markFailed,
		markPolishing: mock(),
		markDelivered: mock(),
	},
}));
mock.module('$lib/state/polish-hud.svelte', () => ({
	polishHud: { begin: mock(), end: mock() },
}));
const { processRecordingPipeline } = await import('./pipeline.js');
type WhisperingApp = import('$lib/whispering/app').WhisperingApp;

const app = {
	get recordingEnabled() {
		return recordingEnabled;
	},
	account: { baseURL: 'https://api.example.test', principalId: 'alice' },
	settings: { get: () => autoUpload },
	recordings: {
		// The row commits before the promise settles; failed creation awaits cleanup.
		async create(fields: Record<string, unknown>) {
			if (creationError !== null) return Err(creationError);
			createdRows++;
			return Ok({ ...fields, id: 'recording-1' as RecordingId });
		},
		uploadAudio,
		get remoteAvailable() {
			return remoteAvailable;
		},
		backup: { kick },
		update: mock(async () => Ok(undefined)),
	},
} as unknown as WhisperingApp;

afterEach(() => {
	autoUpload = true;
	remoteAvailable = true;
	creationError = null;
	transcriptionError = null;
	willPolish = false;
	historyError = null;
	polishedHistoryError = null;
	lifetime = new AbortController();
	finishPolish = undefined;
	finishTranscription = undefined;
	recordingEnabled = true;
});

test('an admitted stop still saves after UI admission closes and failed saving still rejects', async () => {
	recordingEnabled = false;
	const rowsBefore = createdRows;
	const deliveriesBefore = deliverTranscriptionResult.mock.calls.length;
	await processRecordingPipeline(app, {
		audio: new Blob(['audio']),
		durationMs: 100,
	});
	expect(createdRows).toBe(rowsBefore + 1);
	expect(deliverTranscriptionResult).toHaveBeenCalledTimes(deliveriesBefore);
	creationError = {
		name: 'RowCreateFailed',
		message: 'Could not create the recording.',
	};
	await expect(
		processRecordingPipeline(app, {
			audio: new Blob(['audio']),
			durationMs: 100,
		}),
	).rejects.toMatchObject(creationError);
});

test('Account replacement drains raw transcription without starting Polish or delivery', async () => {
	autoUpload = false;
	willPolish = true;
	const entered = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const quiescing = Promise.withResolvers<void>();
	finishTranscription = () => {
		entered.resolve();
		return released.promise;
	};
	const polished = mock(async () => {});
	finishPolish = polished;
	const deliveriesBefore = deliverTranscriptionResult.mock.calls.length;
	let onAccountChange: (next: AuthState) => void = () => {};
	const departure = createDeparture({
		account: app.account,
		auth: {
			onStateChange(listener) {
				onAccountChange = listener;
				return () => {};
			},
		},
		close: async () => {
			lifetime.abort();
		},
	});
	const processing = processRecordingPipeline(app, {
		audio: new Blob(['audio']),
		durationMs: 100,
	});
	departure.attachUi({
		quiesce: async () => {
			recordingEnabled = false;
			quiescing.resolve();
			await processing;
		},
	});
	await entered.promise;
	onAccountChange({ status: 'signed-out' });
	await quiescing.promise;
	expect(lifetime.signal.aborted).toBe(false);
	released.resolve();
	await departure.close();
	expect(polished).not.toHaveBeenCalled();
	expect(deliverTranscriptionResult).toHaveBeenCalledTimes(deliveriesBefore);
	expect(lifetime.signal.aborted).toBe(true);
});

test('retirement during Polish suppresses late history and delivery', async () => {
	willPolish = true;
	autoUpload = false;
	const entered = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	finishPolish = () => {
		entered.resolve();
		return released.promise;
	};
	const writesBefore = saveRecordingHistory.mock.calls.length;
	const deliveriesBefore = deliverTranscriptionResult.mock.calls.length;
	const processing = processRecordingPipeline(app, {
		audio: new Blob(['audio']),
		durationMs: 100,
	});
	await entered.promise;
	lifetime.abort();
	released.resolve();
	await processing;
	expect(saveRecordingHistory).toHaveBeenCalledTimes(writesBefore);
	expect(deliverTranscriptionResult).toHaveBeenCalledTimes(deliveriesBefore);
});

test('failed creation reports dictation loss without entering transcription', async () => {
	creationError = {
		name: 'RowCreateFailed',
		message: 'Could not create the recording.',
	};
	const transcribingBefore = markTranscribing.mock.calls.length;
	await expect(
		processRecordingPipeline(app, {
			audio: new Blob(['audio']),
			durationMs: 100,
		}),
	).rejects.toMatchObject(creationError);
	expect(markFailed).toHaveBeenLastCalledWith({
		tier: 'silent-loss',
		error: creationError,
	});
	expect(markTranscribing).toHaveBeenCalledTimes(transcribingBefore);
});

test('auto-upload kicks only under policy with a remote, without bypassing the runner', async () => {
	await processRecordingPipeline(app, {
		audio: new Blob(['audio']),
		durationMs: 100,
		deliverySource: 'import',
	});
	await new Promise((settle) => setTimeout(settle, 0));
	expect(uploadAudio).not.toHaveBeenCalled();
	expect(kick).toHaveBeenCalledTimes(1);

	autoUpload = false;
	await processRecordingPipeline(app, {
		audio: new Blob(['audio']),
		durationMs: 100,
		deliverySource: 'import',
	});
	await new Promise((settle) => setTimeout(settle, 0));
	expect(uploadAudio).not.toHaveBeenCalled();
	expect(kick).toHaveBeenCalledTimes(1);
	autoUpload = true;
	remoteAvailable = false;
	await processRecordingPipeline(app, {
		audio: new Blob(['audio']),
		durationMs: 100,
		deliverySource: 'import',
	});
	expect(kick).toHaveBeenCalledTimes(1);
});

test('history failure warns after delivering the usable transcription', async () => {
	historyError = {
		name: 'SaveUnconfirmed',
		message: 'The transcription may not appear in recording history.',
	};
	const deliveriesBefore = deliverTranscriptionResult.mock.calls.length;
	const noticesBefore = reportInfo.mock.calls.length;

	await processRecordingPipeline(app, {
		audio: new Blob(['audio']),
		durationMs: 100,
		deliverySource: 'recording',
	});

	expect(deliverTranscriptionResult).toHaveBeenCalledTimes(
		deliveriesBefore + 1,
	);
	expect(deliverTranscriptionResult).toHaveBeenLastCalledWith(app, {
		text: 'transcript',
		source: 'recording',
	});
	expect(reportInfo).toHaveBeenCalledTimes(noticesBefore + 1);
	expect(reportInfo).toHaveBeenLastCalledWith({
		title: 'Transcription delivered, but history may be incomplete',
		description: historyError.message,
	});
});

test('polished history failure still delivers polished text and warns', async () => {
	willPolish = true;
	polishedHistoryError = {
		name: 'SaveUnconfirmed',
		message: 'The transcription may not appear in recording history.',
	};
	const deliveriesBefore = deliverTranscriptionResult.mock.calls.length;
	const noticesBefore = reportInfo.mock.calls.length;

	await processRecordingPipeline(app, {
		audio: new Blob(['audio']),
		durationMs: 100,
		deliverySource: 'recording',
	});

	expect(deliverTranscriptionResult).toHaveBeenCalledTimes(
		deliveriesBefore + 1,
	);
	expect(deliverTranscriptionResult).toHaveBeenLastCalledWith(app, {
		text: 'polished transcript',
		source: 'recording',
	});
	expect(reportInfo).toHaveBeenCalledTimes(noticesBefore + 1);
	expect(reportInfo).toHaveBeenLastCalledWith({
		title: 'Transcription delivered, but history may be incomplete',
		description: polishedHistoryError.message,
	});
});

test('polished history success does not hide an earlier raw history error', async () => {
	willPolish = true;
	historyError = {
		name: 'SaveUnconfirmed',
		message: 'Raw transcript history was not confirmed.',
	};
	const noticesBefore = reportInfo.mock.calls.length;

	await processRecordingPipeline(app, {
		audio: new Blob(['audio']),
		durationMs: 100,
		deliverySource: 'recording',
	});

	expect(saveRecordingHistory).toHaveBeenLastCalledWith(app, 'recording-1', {
		polishedTranscript: 'polished transcript',
	});
	expect(reportInfo).toHaveBeenCalledTimes(noticesBefore + 1);
	expect(reportInfo).toHaveBeenLastCalledWith({
		title: 'Transcription delivered, but history may be incomplete',
		description: historyError.message,
	});
});

for (const deliverySource of ['recording', 'import'] as const) {
	test(`${deliverySource} credit failure offers Add credits and preserves the interrupted work`, async () => {
		transcriptionError = {
			name: 'InsufficientCredits',
			message: 'Add credits, then retry.',
		};
		const deliveriesBefore = deliverTranscriptionResult.mock.calls.length;
		await processRecordingPipeline(app, {
			audio: new Blob(['audio']),
			durationMs: 100,
			deliverySource,
		});
		expect(deliverTranscriptionResult).toHaveBeenCalledTimes(deliveriesBefore);
		const notice = deliverySource === 'recording' ? reportError : rejectLoading;
		expect(notice).toHaveBeenLastCalledWith({
			cause: transcriptionError,
			action: { label: 'Add credits', onClick: expect.any(Function) },
		});
	});
}
