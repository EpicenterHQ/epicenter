/**
 * Recording pipeline ownership tests.
 *
 * Verifies existing-row processing, retained inference, and current-attempt feedback.
 *
 * Key behaviors:
 * - Transcription retries retain the same saved bytes and recording row
 * - Older inference cannot overwrite newer capture feedback
 * - History failure warns only after usable text is delivered
 * - Credit failures offer account management without delivering or resuming work
 */
import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstantString } from '@epicenter/app/field';
import { openMemory } from '@epicenter/app/memory';
import { createBrowserBlobSources } from '@epicenter/blobs/browser';
import { createBunBlobStore } from '@epicenter/blobs/bun';
import { createLocalBlobAccess } from '@epicenter/blobs/owner';
import { Err, Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { whisperingDefinition } from '../data.js';
import { createPendingSaves } from '../whispering/pending-saves.js';
import { newRecordingValues } from '../whispering/recordings.js';

let transcriptionError: { name: string; message: string } | null = null;
let willPolish = false;
let lifetime = new AbortController();
let finishPolish: (() => Promise<void>) | undefined;
let finishTranscription: (() => Promise<void>) | undefined;
let recordingEnabled = true;
const persistedTranscriptions: string[] = [];
const polishSignals: (AbortSignal | undefined)[] = [];
const deliverTranscriptionResult = mock(async () => ({
	outcome: { reach: 'output' } as const,
	notice: { title: 'done' },
}));
const reportInfo = mock();
const reportError = mock();
const rejectLoading = mock();
let historyError: { name: string; message: string } | null = null;
let polishedHistoryError: { name: string; message: string } | null = null;
const saveCleanedTranscription = mock((..._args: unknown[]) =>
	polishedHistoryError === null ? Ok(undefined) : Err(polishedHistoryError),
);

mock.module('$lib/operations/delivery', () => ({
	deliverTranscriptionResult,
}));
mock.module('$lib/operations/process-cleanup', () => ({
	prepareCleanup: (
		owner: WhisperingApp,
		store: unknown,
		{ text, resultId }: { text: string; resultId: string | null },
	) => ({
		willRun: willPolish,
		run: async (signal?: AbortSignal) => {
			if (!willPolish)
				return { text, history: Ok(undefined), cleanupError: null };
			polishSignals.push(signal);
			await finishPolish?.();
			if (owner.signal.aborted)
				return { text, history: Ok(undefined), cleanupError: null };
			const history = await saveCleanedTranscription(
				owner,
				store,
				resultId,
				{ rawText: text, cleanedText: null },
				'polished transcript',
				{},
			);
			return { text: 'polished transcript', history, cleanupError: null };
		},
	}),
}));
mock.module('$lib/operations/sound', () => ({
	playSoundIfEnabled: mock(async () => Ok(undefined)),
}));
mock.module('$lib/operations/transcribe', () => ({
	captureTranscription: () => async () => Ok('captured transcription'),
	transcribeAndPersist: async (
		_app: unknown,
		_store: unknown,
		recordingId: string,
	) => {
		await finishTranscription?.();
		persistedTranscriptions.push(recordingId);
		return transcriptionError !== null
			? Err(transcriptionError)
			: Ok({
					text: 'transcript',
					resultId: 'result',
					history: historyError === null ? Ok(undefined) : Err(historyError),
				});
	},
}));
mock.module('$lib/operations/transcription-history', () => ({
	saveCleanedTranscription,
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
const { saveAudioRecording } = await import('./save-audio-recording.js');
type ProductApp = import('$lib/whispering/app').WhisperingApp;

const directory = await mkdtemp(join(tmpdir(), 'whispering-pipeline-'));
const data = await openMemory(whisperingDefinition);
const local = createBunBlobStore({ directory });
const access = createLocalBlobAccess({
	local,
	sources: createBrowserBlobSources(local),
});
const blobId = expectOk(
	await access.value.add(new Blob(['saved audio'], { type: 'audio/wav' })),
);
const recording = data.tables.recordings.create(
	newRecordingValues({
		audioBlobId: blobId,
		recordedAt: InstantString.now(),
		recordedAtZone: 'UTC',
		duration: 100,
	}),
);
const app = {
	remoteBlobs: null,
	localBlobs: access.value,
	get signal() {
		return lifetime.signal;
	},
	get recordingEnabled() {
		return recordingEnabled;
	},
	authAccount: { baseURL: 'https://api.example.test', principalId: 'alice' },
	local: { ...data, blobs: access.value, kv: { get: () => false } },
	get pendingSaves() {
		return createPendingSaves(lifetime.signal);
	},
	store: data,
} as unknown as WhisperingApp;

mock.module('../whispering/local.js', () => ({ local: app.local }));

afterAll(async () => {
	await access.close();
	await data[Symbol.asyncDispose]();
	await rm(directory, { recursive: true, force: true });
});

afterEach(() => {
	dictationLifecycle.reset();
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
		transcribe: async () => Ok('captured transcription'),
		recordingId: recording.id,
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
	expect(persistedTranscriptions).toContain(recording.id);
	expect(saveCleanedTranscription).toHaveBeenLastCalledWith(
		app,
		app.local,
		'result',
		{ rawText: 'transcript', cleanedText: null },
		'polished transcript',
		expect.any(Object),
	);
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
		transcribe: async () => Ok('captured transcription'),
		recordingId: recording.id,
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

test('closed UI admission starts no inference or delivery for an existing row', async () => {
	recordingEnabled = false;
	const transcriptionsBefore = persistedTranscriptions.length;
	const deliveriesBefore = deliverTranscriptionResult.mock.calls.length;
	await processRecordingPipeline(app, {
		transcribe: async () => Ok('captured transcription'),
		recordingId: recording.id,
	});
	expect(persistedTranscriptions).toHaveLength(transcriptionsBefore);
	expect(deliverTranscriptionResult).toHaveBeenCalledTimes(deliveriesBefore);
});

test('retirement during raw transcription starts no Polish or delivery', async () => {
	willPolish = true;
	const entered = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	finishTranscription = () => {
		entered.resolve();
		return released.promise;
	};
	const polished = mock(async () => {});
	finishPolish = polished;
	const deliveriesBefore = deliverTranscriptionResult.mock.calls.length;
	const processing = processRecordingPipeline(app, {
		transcribe: async () => Ok('captured transcription'),
		recordingId: recording.id,
	});

	await entered.promise;
	lifetime.abort();
	recordingEnabled = false;
	released.resolve();
	await processing;
	expect(polished).not.toHaveBeenCalled();
	expect(deliverTranscriptionResult).toHaveBeenCalledTimes(deliveriesBefore);
	expect(lifetime.signal.aborted).toBe(true);
});

test('retirement during Polish suppresses late history and delivery', async () => {
	willPolish = true;
	const entered = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	finishPolish = () => {
		entered.resolve();
		return released.promise;
	};
	const writesBefore = saveCleanedTranscription.mock.calls.length;
	const deliveriesBefore = deliverTranscriptionResult.mock.calls.length;
	const processing = processRecordingPipeline(app, {
		transcribe: async () => Ok('captured transcription'),
		recordingId: recording.id,
	});
	await entered.promise;
	lifetime.abort();
	released.resolve();
	await processing;
	expect(saveCleanedTranscription).toHaveBeenCalledTimes(writesBefore);
	expect(deliverTranscriptionResult).toHaveBeenCalledTimes(deliveriesBefore);
});

test('failed transcription and retry keep exactly the same row and bytes', async () => {
	const write = spyOn(local, 'put');
	const create = spyOn(data.tables.recordings, 'create');
	try {
		transcriptionError = { name: 'TransportFailed', message: 'Try again' };
		await processRecordingPipeline(app, {
			transcribe: async () => Ok('captured transcription'),
			recordingId: recording.id,
			deliverySource: 'import',
		});
		expect(await expectOk(await access.value.get(blobId)).text()).toBe(
			'saved audio',
		);
		transcriptionError = null;
		await processRecordingPipeline(app, {
			transcribe: async () => Ok('captured transcription'),
			recordingId: recording.id,
			deliverySource: 'import',
		});
		expect(write).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
		expect(data.tables.recordings.rows.map((row) => row.id)).toEqual([
			recording.id,
		]);
		expect(
			expectOk(await access.value.list()).items.map((item) => item.id),
		).toEqual([blobId]);
		expect(persistedTranscriptions.slice(-2)).toEqual([
			recording.id,
			recording.id,
		]);
	} finally {
		write.mockRestore();
		create.mockRestore();
	}
});

test('history failure warns after delivering the usable transcription', async () => {
	historyError = {
		name: 'SaveUnconfirmed',
		message: 'The transcription may not appear in recording history.',
	};
	const deliveriesBefore = deliverTranscriptionResult.mock.calls.length;
	const noticesBefore = reportInfo.mock.calls.length;

	await processRecordingPipeline(app, {
		transcribe: async () => Ok('captured transcription'),
		recordingId: recording.id,
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
		transcribe: async () => Ok('captured transcription'),
		recordingId: recording.id,
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
		transcribe: async () => Ok('captured transcription'),
		recordingId: recording.id,
		deliverySource: 'recording',
	});

	expect(saveCleanedTranscription).toHaveBeenLastCalledWith(
		app,
		app.local,
		'result',
		{ rawText: 'transcript', cleanedText: null },
		'polished transcript',
		expect.any(Object),
	);
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
			transcribe: async () => Ok('captured transcription'),
			recordingId: recording.id,
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

test('admitted audio finishes saving after UI admission closes without starting inference', async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const put = local.put;
	const write = spyOn(local, 'put').mockImplementation(async (...args) => {
		entered.resolve();
		await release.promise;
		return put(...args);
	});
	const transcriptionsBefore = persistedTranscriptions.length;
	let created: Awaited<ReturnType<typeof saveAudioRecording>> | undefined;
	try {
		const saving = saveAudioRecording(
			app,
			new Blob(['admitted'], { type: 'audio/wav' }),
		);
		await entered.promise;
		recordingEnabled = false;
		expect(app.signal.aborted).toBe(false);
		release.resolve();
		created = await saving;
		const row = expectOk(created);
		if (row === null)
			throw new Error('Closing admission must still create the row');
		expect(app.store.tables.recordings.get(row.id)?.audioBlobId).toBe(
			row.audioBlobId,
		);
		expect(await expectOk(await access.value.get(row.audioBlobId)).text()).toBe(
			'admitted',
		);
		await processRecordingPipeline(app, {
			transcribe: async () => Ok('captured transcription'),
			recordingId: row.id,
		});
		expect(persistedTranscriptions).toHaveLength(transcriptionsBefore);
	} finally {
		release.resolve();
		write.mockRestore();
		if (created?.data) {
			app.store.tables.recordings.delete(created.data.id);
			expectOk(await access.value.delete(created.data.audioBlobId));
		}
	}
});

test('audio-only capture retains playable bytes without transcription, polish, delivery, or failure feedback', async () => {
	const before = persistedTranscriptions.length;
	const deliveries = deliverTranscriptionResult.mock.calls.length;
	const polishes = polishSignals.length;
	const failures = markFailed.mock.calls.length;
	const transcribing = markTranscribing.mock.calls.length;
	const row = data.tables.recordings.get(recording.id);
	await processRecordingPipeline(app, {
		recordingId: recording.id,
		transcribe: null,
	});
	expect(persistedTranscriptions).toHaveLength(before);
	expect(deliverTranscriptionResult.mock.calls).toHaveLength(deliveries);
	expect(polishSignals).toHaveLength(polishes);
	expect(markFailed.mock.calls).toHaveLength(failures);
	expect(markTranscribing.mock.calls).toHaveLength(transcribing);
	expect(data.tables.recordings.get(recording.id)).toEqual(row);
	expect(
		await expectOk(await access.value.get(recording.audioBlobId)).text(),
	).toBe('saved audio');
	expect(reportInfo).toHaveBeenLastCalledWith({
		title: 'Audio saved to Local',
		description:
			'Choose a transcription model when you’re ready to turn it into text.',
	});
});

type WhisperingApp = ProductApp & {
	store: import('../whispering/app.js').RecordingStore;
	local: import('../whispering/local.js').LocalStore;
	localBlobs: import('../whispering/local.js').LocalStore['blobs'];
	personal: import('../whispering/personal.js').PersonalStore;
};
