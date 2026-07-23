/**
 * Transcription History Tests
 *
 * Verifies the Result boundary between transcription workflows and workspace
 * row updates.
 *
 * Key behaviors:
 * - A conforming updated row confirms the history save
 * - Rejected storage operations become RecordingHistoryError
 * - Missing and unprojectable rows become unconfirmed history saves
 */
import { expect, mock, test } from 'bun:test';
import { createLogger, memorySink } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { Recording, RecordingId } from '$lib/data';

const recordingId = 'recording-1' as RecordingId;
const recording = { id: recordingId } as Recording;
type UpdateError = { name: string; message: string };
const update = mock(
	async (): Promise<Result<Recording | undefined, UpdateError>> =>
		Ok(recording),
);

const { recordTranscriptionOutcome, saveRecordingHistory } = await import(
	'./transcription-history.js'
);
type WhisperingApp = import('$lib/whispering/app').WhisperingApp;

const app = { recordings: { update } } as unknown as WhisperingApp;

test('conforming updated row confirms the history save', async () => {
	update.mockImplementationOnce(async () => Ok(recording));
	expectOk(
		await saveRecordingHistory(app, recordingId, {
			transcript: 'saved transcript',
		}),
	);
	expect(update).toHaveBeenLastCalledWith(recordingId, {
		transcript: 'saved transcript',
	});
});

test('rejected update becomes RecordingHistoryError', async () => {
	const cause = new Error('workspace unavailable');
	update.mockImplementationOnce(async () => {
		throw cause;
	});

	const error = expectErr(
		await saveRecordingHistory(app, recordingId, {
			transcript: 'delivered text',
		}),
	);
	expect(error).toMatchObject({
		name: 'SaveUnconfirmed',
		recordingId,
		cause,
	});
});

test('missing row becomes an unconfirmed history save', async () => {
	update.mockImplementationOnce(async () => Ok(undefined));

	const error = expectErr(
		await saveRecordingHistory(app, recordingId, {
			transcript: 'delivered text',
		}),
	);
	expect(error.name).toBe('SaveUnconfirmed');
});

test('projection error becomes an unconfirmed history save', async () => {
	const cause = { name: 'NonconformingRow', message: 'row does not conform' };
	update.mockImplementationOnce(async () => Err(cause));

	const error = expectErr(
		await saveRecordingHistory(app, recordingId, {
			transcript: 'delivered text',
		}),
	);
	expect(error).toMatchObject({ name: 'SaveUnconfirmed', cause });
});

test('successful transcription carries its history Result', async () => {
	update.mockImplementationOnce(async () => Ok(recording));

	const success = expectOk(
		await recordTranscriptionOutcome(app, recordingId, Ok('usable text')),
	);
	expect(success.text).toBe('usable text');
	expectOk(success.history);
});

test('provider error remains primary when its failed marker cannot be saved', async () => {
	const providerError = {
		name: 'ProviderFailed',
		message: 'The provider could not transcribe the recording.',
	};
	update.mockImplementationOnce(async () => {
		throw new Error('workspace unavailable');
	});
	const { sink, events } = memorySink();

	const error = expectErr(
		await recordTranscriptionOutcome(
			app,
			recordingId,
			Err(providerError),
			createLogger('test/transcription-history', sink),
		),
	);
	expect(error).toBe(providerError);
	expect(update).toHaveBeenLastCalledWith(recordingId, {
		transcription: {
			status: 'failed',
			completedAt: expect.any(String),
			error: providerError.message,
		},
	});
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({
		level: 'warn',
		source: 'test/transcription-history',
	});
});
