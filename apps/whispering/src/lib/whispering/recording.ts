import type { BlobId } from '@epicenter/blobs';
import type { Recording as RecordingRow } from '../data';

export type Recording = Omit<RecordingRow, 'audioBlobId'> & {
	audioBlobId: BlobId;
};

/** Creation references bytes already committed to the app-local store. */
export type NewRecording = Pick<
	Recording,
	'audioBlobId' | 'recordedAt' | 'recordedAtZone' | 'duration'
>;

export function asRecording(row: RecordingRow): Recording {
	return row as Recording;
}
