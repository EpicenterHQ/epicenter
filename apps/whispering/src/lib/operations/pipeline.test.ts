/**
 * Recording Pipeline Tests
 *
 * Verifies that finalized bytes become the recording-owned blob before
 * transcription and that usable output survives secondary history failures.
 *
 * Key behaviors:
 * - Row creation receives the finalized Blob directly
 * - Transcription uses the minted recording id as the blob address
 * - Raw and polished history failures warn after delivery
 */
import { afterEach, expect, mock, test } from 'bun:test';
import { Err, Ok } from 'wellcrafted/result';
import type { RecordingId } from '$lib/workspace';

let willPolish = false;
const deliverTranscriptionResult = mock(async () => ({
	outcome: { reach: 'output' } as const,
	notice: { title: 'done' },
}));
const reportInfo = mock();
let historyError: { name: string; message: string } | null = null;
let polishedHistoryError: { name: string; message: string } | null = null;
const saveRecordingHistory = mock(async () =>
	polishedHistoryError === null ? Ok(undefined) : Err(polishedHistoryError),
);
const transcribeAndPersist = mock(async () =>
	Ok({
		text: 'transcript',
		history: historyError === null ? Ok(undefined) : Err(historyError),
	}),
);
let createError: Error | null = null;
const createRecording = mock(async (fields: Record<string, unknown>) => {
	if (createError !== null) throw createError;
	return { ...fields, id: 'recording-1' as RecordingId };
});
const markFailed = mock();

mock.module('$lib/operations/delivery', () => ({
	deliverTranscriptionResult,
}));
mock.module('$lib/operations/run-polish', () => ({
	polishWillRun: () => willPolish,
	runPolish: async (_app: unknown, { input }: { input: string }) =>
		Ok(willPolish ? 'polished transcript' : input),
}));
mock.module('$lib/operations/sound', () => ({
	playSoundIfEnabled: mock(async () => Ok(undefined)),
}));
mock.module('$lib/operations/transcribe', () => ({ transcribeAndPersist }));
mock.module('$lib/operations/transcription-history', () => ({
	saveRecordingHistory,
}));
mock.module('$lib/report', () => ({
	log: { warn: mock() },
	report: {
		info: reportInfo,
		error: mock(),
		loading: () => ({ resolve: mock(), reject: mock() }),
	},
}));
mock.module('$lib/state/dictation-lifecycle.svelte', () => ({
	dictationLifecycle: {
		markTranscribing: mock(),
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
	settings: { get: () => false },
	recordings: {
		create: createRecording,
		update: mock(async () => Ok(undefined)),
	},
} as unknown as WhisperingApp;

afterEach(() => {
	willPolish = false;
	historyError = null;
	polishedHistoryError = null;
	createError = null;
});

test('finalized bytes are captured before transcription uses the recording id', async () => {
	const audio = new Blob(['audio'], { type: 'audio/webm' });
	await processRecordingPipeline(app, {
		audio: { kind: 'bytes', bytes: audio },
		durationMs: 100,
		deliverySource: 'import',
	});

	expect(createRecording).toHaveBeenLastCalledWith(
		expect.objectContaining({
			audio: { kind: 'bytes', bytes: audio },
			duration: 100,
		}),
	);
	expect(transcribeAndPersist).toHaveBeenLastCalledWith(app, 'recording-1');
});

test('native capture stays opaque until recordings admits it', async () => {
	const audio = {
		kind: 'native-capture' as const,
		captureId: 'capture_0123456789abcdefghijk',
		byteLength: 4_096,
		acknowledgeAdmission: async () => undefined,
	};
	await processRecordingPipeline(app, {
		audio,
		durationMs: 100,
		deliverySource: 'recording',
	});

	expect(createRecording).toHaveBeenLastCalledWith(
		expect.objectContaining({ audio, duration: 100 }),
	);
	expect(transcribeAndPersist).toHaveBeenLastCalledWith(app, 'recording-1');
});

test('capture failure stops the pipeline and marks dictation as lost', async () => {
	createError = new Error('disk full');
	const transcriptionsBefore = transcribeAndPersist.mock.calls.length;

	await processRecordingPipeline(app, {
		audio: { kind: 'bytes', bytes: new Blob(['audio']) },
		durationMs: 100,
		deliverySource: 'recording',
	});

	expect(transcribeAndPersist).toHaveBeenCalledTimes(transcriptionsBefore);
	expect(markFailed).toHaveBeenLastCalledWith({
		tier: 'silent-loss',
		error: expect.objectContaining({
			name: 'AudioCaptureFailed',
			cause: createError,
		}),
	});
});

test('raw history failure warns after delivering usable text', async () => {
	historyError = {
		name: 'SaveUnconfirmed',
		message: 'The transcription may not appear in recording history.',
	};
	const deliveriesBefore = deliverTranscriptionResult.mock.calls.length;
	const noticesBefore = reportInfo.mock.calls.length;

	await processRecordingPipeline(app, {
		audio: { kind: 'bytes', bytes: new Blob(['audio']) },
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
		audio: { kind: 'bytes', bytes: new Blob(['audio']) },
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

test('polished success preserves an earlier raw history warning', async () => {
	willPolish = true;
	historyError = {
		name: 'SaveUnconfirmed',
		message: 'Raw transcript history was not confirmed.',
	};
	const noticesBefore = reportInfo.mock.calls.length;

	await processRecordingPipeline(app, {
		audio: { kind: 'bytes', bytes: new Blob(['audio']) },
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
