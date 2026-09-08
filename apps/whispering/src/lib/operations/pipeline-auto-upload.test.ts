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
 */
import { afterEach, expect, mock, test } from 'bun:test';
import { generateBlobId } from '@epicenter/blobs';
import { Err, Ok } from 'wellcrafted/result';
import type { RecordingId } from '$lib/data';

let autoUpload = true;
let remoteAvailable = true;
let creationError: { name: string; message: string } | null = null;
const markFailed = mock();
const markTranscribing = mock();
let willPolish = false;
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
	runPolish: async (_app: unknown, { input }: { input: string }) =>
		Ok(willPolish ? 'polished transcript' : input),
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
	settings: { get: () => autoUpload },
	recordings: {
		// The row commits before the promise settles; failed creation awaits cleanup.
		async create(fields: Record<string, unknown>) {
			if (creationError !== null) return Err(creationError);
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
	willPolish = false;
	historyError = null;
	polishedHistoryError = null;
});

test('failed creation reports dictation loss without entering transcription', async () => {
	creationError = {
		name: 'RowCreateFailed',
		message: 'Could not create the recording.',
	};
	const transcribingBefore = markTranscribing.mock.calls.length;
	await expect(
		processRecordingPipeline(app, {
			audioBlobId: generateBlobId(),
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
		audioBlobId: generateBlobId(),
		durationMs: 100,
		deliverySource: 'import',
	});
	await new Promise((settle) => setTimeout(settle, 0));
	expect(uploadAudio).not.toHaveBeenCalled();
	expect(kick).toHaveBeenCalledTimes(1);

	autoUpload = false;
	await processRecordingPipeline(app, {
		audioBlobId: generateBlobId(),
		durationMs: 100,
		deliverySource: 'import',
	});
	await new Promise((settle) => setTimeout(settle, 0));
	expect(uploadAudio).not.toHaveBeenCalled();
	expect(kick).toHaveBeenCalledTimes(1);
	autoUpload = true;
	remoteAvailable = false;
	await processRecordingPipeline(app, {
		audioBlobId: generateBlobId(),
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
