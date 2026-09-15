/**
 * Recording pipeline ownership tests.
 *
 * Verifies row-owned saving, retained inference, and current-attempt feedback.
 *
 * Key behaviors:
 * - New attachments never enter the legacy upload runner
 * - Older inference cannot overwrite newer capture feedback
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
let willPolish = false;
let lifetime = new AbortController();
let finishPolish: (() => Promise<void>) | undefined;
let finishTranscription: (() => Promise<void>) | undefined;
let recordingEnabled = true;
let createdRows = 0;
const persistedTranscriptions: string[] = [];
const polishSignals: (AbortSignal | undefined)[] = [];
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
	runPolish: async ({
		input,
		signal,
	}: {
		input: string;
		signal?: AbortSignal;
	}) => {
		polishSignals.push(signal);
		await finishPolish?.();
		return Ok(willPolish ? 'polished transcript' : input);
	},
}));
mock.module('$lib/operations/sound', () => ({
	playSoundIfEnabled: mock(async () => Ok(undefined)),
}));
mock.module('$lib/operations/transcribe', () => ({
	captureTranscription: () => async () => Ok('captured transcription'),
	transcribeAndPersist: async (_app: unknown, recordingId: string) => {
		await finishTranscription?.();
		persistedTranscriptions.push(recordingId);
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
Reflect.set(
	globalThis,
	'$state',
	Object.assign(<T>(value: T) => value, { raw: <T>(value: T) => value }),
);
mock.module('$lib/state/vad-recorder.svelte', () => ({
	vadRecorder: { state: 'IDLE' },
}));
const { dictationLifecycle } = await import(
	'../state/dictation-lifecycle.svelte'
);
const markFailed = mock(dictationLifecycle.markFailed);
const markTranscribing = mock(dictationLifecycle.markTranscribing);
mock.module('$lib/state/dictation-lifecycle.svelte', () => ({
	dictationLifecycle: {
		...dictationLifecycle,
		markTranscribing,
		markFailed,
	},
}));
const { polishHud } = await import('../state/polish-hud.svelte');
mock.module('$lib/state/polish-hud.svelte', () => ({ polishHud }));
const { processRecordingPipeline } = await import('./pipeline.js');
type WhisperingApp = import('$lib/whispering/app').WhisperingApp;

const app = {
	get signal() {
		return lifetime.signal;
	},
	get recordingEnabled() {
		return recordingEnabled;
	},
	account: { baseURL: 'https://api.example.test', principalId: 'alice' },
	settings: { get: () => autoUpload },
	recordings: {
		get: (id: string) => ({ id, audioBlobId: null }),
		// The row commits before the promise settles; failed creation awaits cleanup.
		async create(fields: Record<string, unknown>) {
			if (creationError !== null) return Err(creationError);
			createdRows++;
			return Ok({
				...fields,
				audioBlobId: null,
				id: 'recording-1' as RecordingId,
			});
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
	dictationLifecycle.reset();
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

test('A inference finishes into its row while B retains current feedback', async () => {
	willPolish = true;
	const entered = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	finishTranscription = () => {
		entered.resolve();
		return released.promise;
	};
	const attemptA = dictationLifecycle.reset();
	const processing = processRecordingPipeline(app, {
		recordingId: 'row-A',
		durationMs: 100,
		isCurrentAttempt: attemptA,
	});
	await entered.promise;
	const attemptB = dictationLifecycle.reset();
	expect(dictationLifecycle.outcome.kind).toBe('none');
	released.resolve();
	await processing;
	expect(attemptA()).toBe(false);
	expect(attemptB()).toBe(true);
	expect(dictationLifecycle.outcome.kind).toBe('none');
	expect(persistedTranscriptions).toContain('row-A');
	expect(saveRecordingHistory).toHaveBeenLastCalledWith(app, 'row-A', {
		polishedTranscript: 'polished transcript',
	});
	expect(deliverTranscriptionResult).toHaveBeenLastCalledWith(app, {
		text: 'polished transcript',
		source: 'recording',
	});
});

test('A polish completion cannot clear or cancel the B polish controller', async () => {
	willPolish = true;
	const entered = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	finishPolish = () => {
		entered.resolve();
		return released.promise;
	};
	const attemptA = dictationLifecycle.reset();
	const processing = processRecordingPipeline(app, {
		recordingId: 'polish-A',
		durationMs: 100,
		isCurrentAttempt: attemptA,
	});
	await entered.promise;
	const signalA = polishSignals.at(-1)!;
	const attemptB = dictationLifecycle.reset();
	// A remains in flight but is no longer reachable through B's ship-raw control.
	polishHud.shipRaw();
	expect(signalA.aborted).toBe(false);
	dictationLifecycle.markPolishing();
	const signalB = polishHud.begin(attemptB);
	released.resolve();
	await processing;
	expect(dictationLifecycle.outcome.kind).toBe('polishing');
	polishHud.shipRaw();
	expect(signalB.aborted).toBe(true);
	expect(signalA.aborted).toBe(false);
	polishHud.end(signalB);
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

test('new attachments never enter the legacy app upload runner', async () => {
	await processRecordingPipeline(app, {
		audio: new Blob(['audio']),
		durationMs: 100,
		deliverySource: 'import',
	});
	await new Promise((settle) => setTimeout(settle, 0));
	expect(uploadAudio).not.toHaveBeenCalled();
	expect(kick).not.toHaveBeenCalled();

	autoUpload = false;
	await processRecordingPipeline(app, {
		audio: new Blob(['audio']),
		durationMs: 100,
		deliverySource: 'import',
	});
	await new Promise((settle) => setTimeout(settle, 0));
	expect(uploadAudio).not.toHaveBeenCalled();
	expect(kick).not.toHaveBeenCalled();
	autoUpload = true;
	remoteAvailable = false;
	await processRecordingPipeline(app, {
		audio: new Blob(['audio']),
		durationMs: 100,
		deliverySource: 'import',
	});
	expect(kick).not.toHaveBeenCalled();
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
