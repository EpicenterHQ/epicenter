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
import type { Recording } from '$lib/whispering/recording';

const recordingId = 'recording-1' as RecordingId;
const recording = { id: recordingId } as Recording;
// `patch` is synchronous and throws on a refusal, so a rejection is modelled
// by throwing rather than by returning an Err.
const patch = mock((): Recording => recording);

const { recordTranscriptionOutcome, saveRecordingHistory } = await import(
	'./transcription-history.js'
);
type WhisperingApp = import('$lib/whispering/app').WhisperingApp;

const app = { recordings: { patch } } as unknown as WhisperingApp;

test('a committed write confirms the history save', () => {
	patch.mockImplementationOnce(() => recording);
	expectOk(
		saveRecordingHistory(app, recordingId, { transcript: 'saved transcript' }),
	);
	expect(patch).toHaveBeenLastCalledWith(recordingId, {
		transcript: 'saved transcript',
	});
});

test('a refused write becomes RecordingHistoryError', () => {
	const cause = new Error('the store refused the write');
	patch.mockImplementationOnce(() => {
		throw cause;
	});

	const error = expectErr(
		saveRecordingHistory(app, recordingId, { transcript: 'delivered text' }),
	);
	expect(error).toMatchObject({
		name: 'SaveUnconfirmed',
		recordingId,
		cause,
	});
});

test('successful transcription carries its history Result', () => {
	patch.mockImplementationOnce(() => recording);

	const success = expectOk(
		recordTranscriptionOutcome(app, recordingId, Ok('usable text')),
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

test('provider error remains primary when its failed marker cannot be saved', () => {
	const providerError = {
		name: 'ProviderFailed',
		message: 'The provider could not transcribe the recording.',
	};
	patch.mockImplementationOnce(() => {
		throw new Error('the store refused the write');
	});
	const { sink, events } = memorySink();

	const error = expectErr(
		recordTranscriptionOutcome(
			app,
			recordingId,
			Err(providerError),
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
