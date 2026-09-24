import { InstantString } from '@epicenter/app/field';
import {
	type AnyTaggedError,
	defineErrors,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, isErr, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { RecordingId, Transcription } from '../data.js';
import type { WhisperingApp, WhisperingData } from '../whispering/app.js';

export const RecordingHistoryError = defineErrors({
	SaveUnconfirmed: ({ recordingId, cause }: { recordingId: RecordingId; cause: unknown }) => ({
		message: 'The transcription may not appear in recording history.',
		recordingId,
		cause,
	}),
});
export type RecordingHistoryError = InferErrors<typeof RecordingHistoryError>;

export type TranscriptionSuccess = {
	text: string;
	resultId: string | null;
	history: Result<void, AnyTaggedError>;
};

/** One successful inference owns one Original, even if persistence needs a retry. */
export async function recordTranscriptionOutcome<TError extends AnyTaggedError>(
	app: WhisperingApp,
	store: WhisperingData,
	recordingId: RecordingId,
	transcription: Result<string, TError>,
	receipt = app.pendingSaves.reserve('Transcript'),
	attemptedAt = InstantString.now(),
	selection: { connectionId: string; model: string } | null = null,
): Promise<Result<TranscriptionSuccess, TError>> {
	if (isErr(transcription)) {
		receipt.discard();
		return Err(transcription.error);
	}
	const text = transcription.data;
	const values = {
		recordingId,
		attemptedAt,
		completedAt: InstantString.now(),
		rawText: text,
		cleanedText: null,
		connectionId: selection?.connectionId ?? null,
		model: selection?.model ?? null,
		legacyRecordingId: null,
	};
	let created: Transcription | undefined;
	let attempted = false;
	const history = await receipt.run(() =>
		tryAsync({
			try: async () => {
				app.signal.throwIfAborted();
				if (!store.tables.recordings.get(recordingId))
					throw new Error('The recording is no longer available.');
				if (!attempted) {
					attempted = true;
					created = store.tables.transcriptions.create(values);
				}
				if (!created)
					throw new Error('Creation acceptance is uncertain. Do not create another result.');
				await store.persistence.flush();
				app.signal.throwIfAborted();
				if (store.persistence.get() !== 'saved')
					throw new Error('Local persistence is blocked.');
				const saved = store.tables.transcriptions.get(created.id);
				if (!saved || saved.rawText !== text || saved.recordingId !== recordingId)
					throw new Error('The retained Original is no longer present.');
			},
			catch: (cause) => RecordingHistoryError.SaveUnconfirmed({ recordingId, cause }),
		}),
	);
	return Ok({ text, resultId: created?.id ?? null, history });
}

/** Accept one Cleaned value only for the Original and version the caller saw. */
export async function saveCleanedTranscription(
	app: WhisperingApp,
	store: WhisperingData,
	resultId: string,
	expected: Pick<Transcription, 'rawText' | 'cleanedText'>,
	cleanedText: string | null,
	receipt = app.pendingSaves.reserve('Cleaned transcript'),
): Promise<Result<void, AnyTaggedError>> {
	return receipt.run(() =>
		tryAsync({
			try: async () => {
				app.signal.throwIfAborted();
				const current = store.tables.transcriptions.get(resultId);
				if (!current || current.rawText !== expected.rawText)
					throw new Error('The Original changed or is no longer available.');
				if (current.cleanedText !== cleanedText) {
					if (current.cleanedText !== expected.cleanedText)
						throw new Error('The Cleaned version changed after the preview opened.');
					const written = store.tables.transcriptions.update(resultId, { cleanedText });
					if (written.error) throw written.error;
				}
				await store.persistence.flush();
				app.signal.throwIfAborted();
				if (store.persistence.get() !== 'saved' ||
					store.tables.transcriptions.get(resultId)?.cleanedText !== cleanedText)
					throw new Error('The Cleaned version was not confirmed.');
			},
			catch: (cause) => RecordingHistoryError.SaveUnconfirmed({
				recordingId: store.tables.transcriptions.get(resultId)?.recordingId ?? 'unknown',
				cause,
			}),
		}),
	);
}
