import type {
	BlobSource,
	BlobSourceFailed,
	BlobStoreError,
} from '@epicenter/blobs';
import { type Result } from 'wellcrafted/result';
import { type Recording } from '../data.js';
import type { RecordingStore, WhisperingData } from './app.js';
export type NewRecording = Pick<
	Recording,
	'audioBlobId' | 'recordedAt' | 'recordedAtZone' | 'duration'
>;

export function newRecordingValues(value: NewRecording) {
	return {
		...value,
		title: '',
		transcript: '',
		polishedTranscript: null,
		transcriptionStatus: 'pending',
		transcriptionCompletedAt: null,
		transcriptionError: null,
	};
}

/** A successful patch must leave a conforming recording readable by its caller. */
export function updateRecording(
	store: Pick<WhisperingData, 'tables'>,
	id: string,
	changes: Partial<Omit<Recording, 'id'>>,
) {
	const written = store.tables.recordings.update(id, changes);
	if (written.error !== null) throw written.error;
	const row = store.tables.recordings.get(id);
	if (!row)
		throw new Error(`Recording '${id}' no longer reads whole after this patch`);
	return row;
}

/** Audio addresses belong only to the row's containing store. */
export function openRecordingAudio(
	store: Pick<RecordingStore, 'blobs'>,
	row: Pick<Recording, 'audioBlobId'>,
): Promise<
	Result<BlobSource, BlobStoreError | BlobSourceFailed>
> {
	return store.blobs.open(row.audioBlobId);
}

export function readRecordingAudio(
	store: Pick<RecordingStore, 'tables' | 'blobs'>,
	id: string,
): Promise<Result<Blob, BlobStoreError>> {
	const row = store.tables.recordings.get(id);
	if (!row) throw new Error(`Recording '${id}' no longer exists.`);
	return store.blobs.get(row.audioBlobId);
}

/** The recording history displays newest captures first. */
export function sortedRecordings(store: Pick<WhisperingData, 'tables'>) {
	return store.tables.recordings.rows.toSorted(
		(left, right) =>
			new Date(right.recordedAt).getTime() -
			new Date(left.recordedAt).getTime(),
	);
}
