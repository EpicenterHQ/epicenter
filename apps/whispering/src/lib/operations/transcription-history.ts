import { InstantString } from '@epicenter/field';
import {
	type AnyTaggedError,
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Err, isErr, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { Recording, RecordingId } from '$lib/data';
import type { WhisperingApp } from '$lib/whispering/app';

const defaultLog = createLogger('whispering/transcription-history');

export const RecordingHistoryError = defineErrors({
	SaveUnconfirmed: ({
		recordingId,
		cause,
	}: {
		recordingId: RecordingId;
		cause: unknown;
	}) => ({
		message: 'The transcription may not appear in recording history.',
		recordingId,
		cause,
	}),
});
export type RecordingHistoryError = InferErrors<typeof RecordingHistoryError>;

export type TranscriptionSuccess = {
	text: string;
	history: Result<void, RecordingHistoryError>;
};

/**
 * Attempt one transcription-related recording update without letting storage,
 * transport, or release-lens failures escape the operation's Result contract.
 * The current record update may apply a patch before its row projection
 * fails, so every non-success is described conservatively as an unconfirmed
 * history save rather than a definitive failed write.
 */
export async function saveRecordingHistory(
	app: WhisperingApp,
	recordingId: RecordingId,
	changes: Partial<Omit<Recording, 'id'>>,
): Promise<Result<void, RecordingHistoryError>> {
	const { data: update, error: updateError } = await tryAsync({
		try: () => app.recordings.update(recordingId, changes),
		catch: (cause) =>
			RecordingHistoryError.SaveUnconfirmed({ recordingId, cause }),
	});
	if (updateError !== null) return Err(updateError);

	const { data: row, error: projectionError } = update;
	if (projectionError !== null) {
		return RecordingHistoryError.SaveUnconfirmed({
			recordingId,
			cause: projectionError,
		});
	}
	if (row === undefined) {
		return RecordingHistoryError.SaveUnconfirmed({
			recordingId,
			cause: new Error('The recording no longer exists'),
		});
	}
	return Ok(undefined);
}

/** Record a provider outcome without letting secondary history failure replace it. */
export async function recordTranscriptionOutcome<TError extends AnyTaggedError>(
	app: WhisperingApp,
	recordingId: RecordingId,
	transcription: Result<string, TError>,
	log: Logger = defaultLog,
): Promise<Result<TranscriptionSuccess, TError>> {
	if (isErr(transcription)) {
		const error = transcription.error;
		const { error: historyError } = await saveRecordingHistory(
			app,
			recordingId,
			{
				transcription: {
					status: 'failed',
					completedAt: InstantString.now(),
					error: extractErrorMessage(error),
				},
			},
		);
		if (historyError !== null) {
			log.warn(new Error(historyError.message, { cause: historyError }));
		}
		return Err(error);
	}

	const text = transcription.data;
	const history = await saveRecordingHistory(app, recordingId, {
		transcript: text,
		polishedTranscript: null,
		transcription: {
			status: 'completed',
			completedAt: InstantString.now(),
		},
	});
	return Ok({ text, history });
}
