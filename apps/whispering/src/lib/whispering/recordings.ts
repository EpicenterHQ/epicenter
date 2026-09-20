import type { BlobId } from '@epicenter/blobs';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, trySync } from 'wellcrafted/result';
import type { WhisperingAppHandle, WhisperingData } from './app.js';
import type { Recording } from '../data.js';
export type NewRecording = Pick<
	Recording,
	'audioBlobId' | 'recordedAt' | 'recordedAtZone' | 'duration'
>;

export const RecordingCreationError = defineErrors({
	RowCreateFailed: ({
		audioBlobId,
		cause,
	}: {
		audioBlobId: BlobId;
		cause: unknown;
	}) => ({
		message:
			'Audio was saved, but the recording could not be added to this library.',
		audioBlobId,
		cause,
	}),
});
export type RecordingCreationError = InferErrors<typeof RecordingCreationError>;
export type RecordingStorage = {
	library: Pick<WhisperingData, 'tables'>;
	blobs: WhisperingAppHandle['blobs'];
};

/** Row publication never removes the audio bytes that were saved first. */
export function createRecording(
	library: Pick<WhisperingData, 'tables'>,
	value: NewRecording,
) {
	return trySync({
		try: () =>
			library.tables.recordings.create({
				...value,
				title: '',
				transcript: '',
				polishedTranscript: null,
				audioUrl: null,
				transcriptionStatus: 'pending',
				transcriptionCompletedAt: null,
				transcriptionError: null,
			}),
		catch: (cause) =>
			RecordingCreationError.RowCreateFailed({
				audioBlobId: value.audioBlobId,
				cause,
			}),
	});
}

/** A successful patch must leave a conforming recording readable by its caller. */
export function updateRecording(
	library: Pick<WhisperingData, 'tables'>,
	id: string,
	changes: Partial<Omit<Recording, 'id'>>,
) {
	const written = library.tables.recordings.update(id, changes);
	if (written.error !== null) throw written.error;
	const row = library.tables.recordings.get(id);
	if (!row)
		throw new Error(`Recording '${id}' no longer reads whole after this patch`);
	return row;
}

/** Playback uses local bytes first, then an explicitly uploaded copy. */
export async function openRecordingAudio(
	blobs: WhisperingAppHandle['blobs'],
	{ audioBlobId, audioUrl }: Pick<Recording, 'audioBlobId' | 'audioUrl'>,
) {
	const local = await blobs.local.open(audioBlobId);
	if (local.error?.name !== 'BlobNotFound' || !audioUrl || !blobs.remote)
		return local;
	return blobs.remote.open(audioUrl);
}

/** Requests and downloads use the same explicit uploaded-copy rule as playback. */
export async function readRecordingAudio(app: RecordingStorage, id: string) {
	const row = app.library.tables.recordings.get(id);
	if (!row) throw new Error(`Recording '${id}' no longer exists.`);
	const local = await app.blobs.local.get(row.audioBlobId);
	if (
		local.error?.name !== 'BlobNotFound' ||
		!row.audioUrl ||
		!app.blobs.remote
	)
		return local;
	return app.blobs.remote.get(row.audioUrl);
}

export async function recordingAudioAvailability(
	app: RecordingStorage,
	id: string,
) {
	const row = app.library.tables.recordings.get(id);
	if (!row?.audioBlobId) return Ok('unavailable' as const);
	const result = await app.blobs.local.stat(row.audioBlobId);
	if (result.error === null) return Ok('local' as const);
	if (result.error.name === 'BlobNotFound')
		return Ok(
			row.audioUrl && app.blobs.remote
				? ('remote' as const)
				: ('unavailable' as const),
		);
	return Err(result.error);
}

/** The recording history displays newest captures first. */
export function sortedRecordings(library: Pick<WhisperingData, 'tables'>) {
	return library.tables.recordings.rows.toSorted(
		(left, right) =>
			new Date(right.recordedAt).getTime() -
			new Date(left.recordedAt).getTime(),
	);
}
