import { InstantString } from '@epicenter/data/field';
import {
	type AnyTaggedError,
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Err, isErr, Ok, type Result, trySync } from 'wellcrafted/result';
import type { RecordingId } from '$lib/data';
import type { WhisperingApp } from '$lib/whispering/app';
import type { Recording } from '$lib/whispering/recording';

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
 * Attempt one transcription-related recording patch without letting a refused
 * write escape the operation's Result contract.
 *
 * Still conservative about what a failure means, and still asynchronous. The
 * write itself is synchronous now, but every caller is inside an async
 * transcription pipeline and the outcome is reported the same way either
 * direction, so the shape stays.
 */
export function saveRecordingHistory(
	app: WhisperingApp,
	recordingId: RecordingId,
	changes: Partial<Omit<Recording, 'id' | 'audioBlobId' | 'uploadedAt'>>,
): Result<void, RecordingHistoryError> {
	const { error } = trySync({
		try: () => app.recordings.patch(recordingId, changes),
		catch: (cause) =>
			RecordingHistoryError.SaveUnconfirmed({ recordingId, cause }),
	});
	return error !== null ? Err(error) : Ok(undefined);
}

/** Record a provider outcome without letting secondary history failure replace it. */
export function recordTranscriptionOutcome<TError extends AnyTaggedError>(
	app: WhisperingApp,
	recordingId: RecordingId,
	transcription: Result<string, TError>,
	log: Logger = defaultLog,
): Result<TranscriptionSuccess, TError> {
	// The outcome is three columns rather than one nested object: a workspace has no
	// expression for an inline object, and flattening also lets a failure's
	// message merge independently of its timestamp (`data.ts`).
	if (isErr(transcription)) {
		const error = transcription.error;
		const { error: historyError } = saveRecordingHistory(app, recordingId, {
			transcriptionStatus: 'failed',
			transcriptionCompletedAt: InstantString.now(),
			transcriptionError: extractErrorMessage(error),
		});
		if (historyError !== null) {
			log.warn(historyError);
		}
		return Err(error);
	}

	const text = transcription.data;
	const history = saveRecordingHistory(app, recordingId, {
		transcript: text,
		polishedTranscript: null,
		transcriptionStatus: 'completed',
		transcriptionCompletedAt: InstantString.now(),
		transcriptionError: null,
	});
	return Ok({ text, history });
}
