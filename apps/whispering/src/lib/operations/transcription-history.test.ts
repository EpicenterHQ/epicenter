/**
 * Transcription History Tests
 *
 * Verifies the Result boundary between transcription workflows and the row
 * update behind them.
 *
 * Key behaviors:
 * - A committed write confirms the history save
 * - A refused write becomes a RecordingHistoryError rather than escaping
 * - A failed outcome writes the three flat transcription columns
 */

import { expect, mock, test } from 'bun:test';
import { createLogger, memorySink } from 'wellcrafted/logger';
import { Err, Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { RecordingId } from '$lib/data';
import type { Recording } from '../data.js';
import { createPendingSaves } from '../whispering/pending-saves.js';

const recordingId = 'recording-1' as RecordingId;
const recording = { id: recordingId } as Recording;
const write = (_id: string, changes: Partial<Recording>) => {
	Object.assign(recording, changes);
	return Ok(undefined);
};
const patch = mock(write);

const { recordTranscriptionOutcome, saveRecordingHistory } = await import(
	'./transcription-history.js'
);
type ProductApp = import('$lib/whispering/app').WhisperingApp;

const signal = new AbortController().signal;
const app = {
	signal,
	pendingSaves: createPendingSaves(signal),
	store: {
		persistence: { flush: async () => {}, get: () => 'saved' },
		tables: { recordings: { update: patch, get: () => recording } },
	},
} as unknown as WhisperingApp;

test('a committed write confirms the history save', async () => {
	patch.mockImplementationOnce(write);
	expectOk(
		await saveRecordingHistory(app, app.store, recordingId, {
			transcript: 'saved transcript',
		}),
	);
	expect(patch).toHaveBeenLastCalledWith(recordingId, {
		transcript: 'saved transcript',
	});
});

test('a refused write becomes RecordingHistoryError', async () => {
	const cause = new Error('the store refused the write');
	patch.mockImplementationOnce(() => {
		throw cause;
	});

	const error = expectErr(
		await saveRecordingHistory(app, app.store, recordingId, {
			transcript: 'delivered text',
		}),
	);
	expect(error).toMatchObject({
		name: 'SaveUnconfirmed',
		recordingId,
		cause,
	});
});

test('successful transcription carries its history Result', async () => {
	patch.mockImplementationOnce(write);

	const success = expectOk(
		await recordTranscriptionOutcome(
			app,
			app.store,
			recordingId,
			Ok('usable text'),
		),
	);
	expect(success.text).toBe('usable text');
	expectOk(success.history);
	// Three flat columns rather than one nested outcome: a workspace has no
	// expression for an inline object (`data.ts`).
	expect(patch).toHaveBeenLastCalledWith(recordingId, {
		transcript: 'usable text',
		polishedTranscript: null,
		transcriptionStatus: 'completed',
		transcriptionCompletedAt: expect.any(String),
		transcriptionError: null,
	});
});

test('provider error remains primary when its failed marker cannot be saved', async () => {
	const providerError = {
		name: 'ProviderFailed',
		message: 'The provider could not transcribe the recording.',
	};
	patch.mockImplementationOnce(() => {
		throw new Error('the store refused the write');
	});
	const { sink, events } = memorySink();

	const error = expectErr(
		await recordTranscriptionOutcome(
			app,
			app.store,
			recordingId,
			Err(providerError),
			undefined,
			createLogger('test/transcription-history', sink),
		),
	);
	expect(error).toBe(providerError);
	expect(patch).toHaveBeenLastCalledWith(recordingId, {
		transcriptionStatus: 'failed',
		transcriptionCompletedAt: expect.any(String),
		transcriptionError: providerError.message,
	});
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({
		level: 'warn',
		source: 'test/transcription-history',
	});
});

test('retrying an older refused transcript never overwrites newer raw or polished text', async () => {
	const signal = new AbortController().signal;
	let row = {
		id: recordingId,
		transcript: 'original',
		polishedTranscript: null,
	} as Recording;
	let reject = true;
	const owner = {
		signal,
		pendingSaves: createPendingSaves(signal),
		store: {
			persistence: { flush: async () => {}, get: () => 'saved' },
			tables: {
				recordings: {
					get: () => row,
					update: (_id: string, changes: Partial<Recording>) => {
						if (reject) throw new Error('refused');
						row = { ...row, ...changes };
						return Ok(undefined);
					},
				},
			},
		},
	} as unknown as WhisperingApp;
	expectErr(
		await saveRecordingHistory(owner, owner.store, recordingId, {
			transcript: 'old attempt',
			polishedTranscript: null,
		}),
	);
	reject = false;
	row = {
		...row,
		transcript: 'new attempt',
		polishedTranscript: 'new polished',
	};
	await owner.pendingSaves.entries[0]!.retry();
	expect(row.transcript).toBe('new attempt');
	expect(row.polishedTranscript).toBe('new polished');
	expect(owner.pendingSaves.entries).toHaveLength(1);
});

type WhisperingApp = ProductApp & {
	store: import('../whispering/app.js').RecordingStore;
	local: import('../whispering/local.js').LocalStore;
	localBlobs: import('../whispering/local.js').LocalStore['blobs'];
	personal: import('../whispering/personal.js').PersonalStore;
};

for (const alteration of ['delete', 'edit'] as const) {
	test(`accepted transcript remains recoverable when row changes before retry: ${alteration}`, async () => {
		const signal = new AbortController().signal;
		let row: Recording | undefined = {
			id: recordingId,
			transcript: 'original',
		} as Recording;
		let status = 'blocked';
		const owner = {
			signal,
			pendingSaves: createPendingSaves(signal),
		} as ProductApp;
		const store = {
			persistence: { flush: async () => {}, get: () => status },
			tables: {
				recordings: {
					get: () => row,
					update: (_id: string, changes: Partial<Recording>) => {
						row = { ...row!, ...changes };
						return Ok(undefined);
					},
				},
			},
		} as unknown as WhisperingApp['store'];
		expectErr(
			await saveRecordingHistory(owner, store, recordingId, {
				transcript: 'retained output',
			}),
		);
		row =
			alteration === 'delete'
				? undefined
				: { ...row!, transcript: 'newer output' };
		status = 'saved';
		await owner.pendingSaves.entries[0]!.retry();
		expect(owner.pendingSaves.entries).toHaveLength(1);
		expect(row?.transcript).toBe(
			alteration === 'delete' ? undefined : 'newer output',
		);
	});
}
