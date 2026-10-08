/**
 * Recording Pipeline Auto-Upload Tests
 *
 * Verifies the intentionally small automatic policy at the row-creation seam.
 *
 * Key behaviors:
 * - An enabled setting attempts the same upload operation exactly once
 * - A disabled setting performs no upload
 * - Upload remains best-effort and does not block transcription
 * - History failure warns only after usable text is delivered
 * - A late polish cannot replace a manually saved transcript's displayed text
 */
import { afterEach, expect, mock, test } from 'bun:test';
import { generateBlobId } from '@epicenter/blobs';
import { Err, Ok } from 'wellcrafted/result';
import type { RecordingId } from '$lib/workspace';

let autoUpload = true;
let willPolish = false;
let savedTranscript = 'transcript';
let savedPolish: string | null = null;
let polishGate: Promise<void> | undefined;
let polishStarted: (() => void) | undefined;
const uploadAudio = mock(async () => Ok(undefined));
const deliverTranscriptionResult = mock(async () => ({
	outcome: { reach: 'output' } as const,
	notice: { title: 'done' },
}));
const reportInfo = mock();
let historyError: { name: string; message: string } | null = null;
let polishedHistoryError: { name: string; message: string } | null = null;
const saveRecordingHistory = mock(() =>
	polishedHistoryError === null ? Ok(undefined) : Err(polishedHistoryError),
);

mock.module('$lib/operations/delivery', () => ({
	deliverTranscriptionResult,
}));
mock.module('$lib/operations/run-polish', () => ({
	polishWillRun: () => willPolish,
	runPolish: async (_app: unknown, { input }: { input: string }) => {
		polishStarted?.();
		await polishGate;
		return Ok(willPolish ? 'polished transcript' : input);
	},
}));
mock.module('$lib/operations/sound', () => ({
	playSoundIfEnabled: mock(async () => Ok(undefined)),
}));
mock.module('$lib/operations/transcribe', () => ({
	transcribeAndPersist: async () =>
		Ok({
			text: 'transcript',
			history: historyError === null ? Ok(undefined) : Err(historyError),
		}),
}));
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
		markFailed: mock(),
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
	settings: { get: () => autoUpload },
	recordings: {
		// Synchronous, like the domain it stands in for: the store commits before
		// `create` returns, so there is no promise for the pipeline to await.
		create(fields: Record<string, unknown>) {
			return { ...fields, id: 'recording-1' as RecordingId };
		},
		uploadAudio,
		get: () => ({
			transcript: savedTranscript,
			polishedTranscript: savedPolish,
		}),
		update: mock(async () => Ok(undefined)),
	},
} as unknown as WhisperingApp;

afterEach(() => {
	autoUpload = true;
	willPolish = false;
	historyError = null;
	polishedHistoryError = null;
	savedTranscript = 'transcript';
	savedPolish = null;
	polishGate = undefined;
	polishStarted = undefined;
});

test('a late polish is not stored after the raw transcript was manually changed', async () => {
	autoUpload = false;
	willPolish = true;
	const gate = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	polishGate = gate.promise;
	polishStarted = started.resolve;
	const writesBefore = saveRecordingHistory.mock.calls.length;
	const running = processRecordingPipeline(app, {
		audioBlobId: generateBlobId(),
		durationMs: 100,
		deliverySource: 'import',
	});
	await started.promise;
	savedTranscript = 'Saved by the person while polish was running';
	gate.resolve();
	await running;
	expect(saveRecordingHistory).toHaveBeenCalledTimes(writesBefore);
});

test('a late polish is not stored over a newer polished transcript', async () => {
	autoUpload = false;
	willPolish = true;
	const gate = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	polishGate = gate.promise;
	polishStarted = started.resolve;
	const writesBefore = saveRecordingHistory.mock.calls.length;
	const running = processRecordingPipeline(app, {
		audioBlobId: generateBlobId(),
		durationMs: 100,
		deliverySource: 'import',
	});
	await started.promise;
	savedPolish = 'A newer delivered version';
	gate.resolve();
	await running;
	expect(saveRecordingHistory).toHaveBeenCalledTimes(writesBefore);
});

test('auto-upload attempts once for each new row only when enabled', async () => {
	await processRecordingPipeline(app, {
		audioBlobId: generateBlobId(),
		durationMs: 100,
		deliverySource: 'import',
	});
	await Promise.resolve();
	expect(uploadAudio).toHaveBeenCalledTimes(1);
	expect(uploadAudio).toHaveBeenLastCalledWith('recording-1');

	autoUpload = false;
	await processRecordingPipeline(app, {
		audioBlobId: generateBlobId(),
		durationMs: 100,
		deliverySource: 'import',
	});
	await Promise.resolve();
	expect(uploadAudio).toHaveBeenCalledTimes(1);
});

test('history failure warns after delivering the usable transcription', async () => {
	historyError = {
		name: 'SaveUnconfirmed',
		message: 'The transcription may not appear in recording history.',
	};
	const deliveriesBefore = deliverTranscriptionResult.mock.calls.length;
	const noticesBefore = reportInfo.mock.calls.length;

	await processRecordingPipeline(app, {
		audioBlobId: generateBlobId(),
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
		audioBlobId: generateBlobId(),
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
		audioBlobId: generateBlobId(),
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
