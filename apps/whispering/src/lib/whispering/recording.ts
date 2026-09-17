import type { BlobId } from '@epicenter/blobs';
import type { Recording as RecordingRow, WhisperingData } from '../data';

export type Recording = Omit<RecordingRow, 'audioBlobId'> & {
	audioBlobId: BlobId;
};

/** Creation references bytes already committed to the app-local store. */
export type NewRecording = Omit<
	Parameters<WhisperingData['tables']['recordings']['create']>[0],
	| 'audioUrl'
	| 'transcriptionStatus'
	| 'transcriptionCompletedAt'
	| 'transcriptionError'
>;

export function asRecording(row: RecordingRow): Recording {
	return row as Recording;
}
