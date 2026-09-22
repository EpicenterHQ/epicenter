import { InstantString } from '@epicenter/app/field';
import {
	type AnyTaggedError,
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import {
	Err,
	isErr,
	Ok,
	type Result,
	tryAsync,
	trySync,
} from 'wellcrafted/result';
import type { RecordingId } from '$lib/data';
import type { WhisperingApp } from '$lib/whispering/app';
import type { Recording } from '../data.js';
import type { WhisperingData } from '../whispering/app.js';
import { updateRecording } from '../whispering/recordings.js';

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
	history: Result<void, AnyTaggedError>;
};

/**
 * Attempt one transcription-related recording patch without letting a refused
 * write escape the operation's Result contract.
 */
export async function saveRecordingHistory(
	app: WhisperingApp,
	store: WhisperingData,
	recordingId: RecordingId,
	changes: Partial<Omit<Recording, 'id' | 'audioBlobId'>>,
	receipt = app.pendingSaves.reserve('Transcript'),
) {
	const snapshot = { ...changes };
	const baseline = trySync({
		try: () => {
			const before = store.tables.recordings.get(recordingId);
			return Object.fromEntries(
				Object.keys(snapshot).map((key) => [
					key,
					before?.[key as keyof Recording],
				]),
			);
		},
		catch: (cause) =>
			RecordingHistoryError.SaveUnconfirmed({ recordingId, cause }),
	});
	return receipt.run(() =>
		tryAsync({
			try: async () => {
				app.signal.throwIfAborted();
				if (baseline.error) throw baseline.error;
				const original = baseline.data;
				{
					const current = store.tables.recordings.get(recordingId);
					if (!current)
						throw new Error(
							'The recording is missing or nonconforming. Text remains in this recovery attempt.',
						);
					const keys = Object.keys(snapshot) as (keyof typeof snapshot)[];
					const alreadyWritten = keys.every(
						(key) => current[key] === snapshot[key],
					);
					if (!alreadyWritten) {
						if (!keys.every((key) => current[key] === original[key]))
							throw new Error(
								'Newer recording edits conflict with this retained text. It will not overwrite them.',
							);
						updateRecording(store, recordingId, snapshot);
					}
				}
				await store.persistence.flush();
				app.signal.throwIfAborted();
				if (store.persistence.get() !== 'saved')
					throw new Error('Local persistence is blocked.');
				const persisted = store.tables.recordings.get(recordingId);
				if (
					!persisted ||
					!Object.keys(snapshot).every(
						(key) =>
							persisted[key as keyof Recording] ===
							snapshot[key as keyof typeof snapshot],
					)
				)
					throw new Error(
						'The retained transcript is no longer present in this recording.',
					);
			},
			catch: (cause) =>
				RecordingHistoryError.SaveUnconfirmed({ recordingId, cause }),
		}),
	);
}

/** Record a provider outcome without letting secondary history failure replace it. */
export async function recordTranscriptionOutcome<TError extends AnyTaggedError>(
	app: WhisperingApp,
	store: WhisperingData,
	recordingId: RecordingId,
	transcription: Result<string, TError>,
	receipt = app.pendingSaves.reserve('Transcript'),
	log: Logger = defaultLog,
) {
	// The outcome is three columns rather than one nested object: a workspace has no
	// expression for an inline object, and flattening also lets a failure's
	// message merge independently of its timestamp (`data.ts`).
	if (isErr(transcription)) {
		const error = transcription.error;
		const { error: historyError } = await saveRecordingHistory(
			app,
			store,
			recordingId,
			{
				transcriptionStatus: 'failed',
				transcriptionCompletedAt: InstantString.now(),
				transcriptionError: extractErrorMessage(error),
			},
			receipt,
		);
		if (historyError !== null) {
			log.warn(historyError);
		}
		return Err(error);
	}

	const text = transcription.data;
	const history = await saveRecordingHistory(
		app,
		store,
		recordingId,
		{
			transcript: text,
			polishedTranscript: null,
			transcriptionStatus: 'completed',
			transcriptionCompletedAt: InstantString.now(),
			transcriptionError: null,
		},
		receipt,
	);
	return Ok({ text, history });
}
