import type { BlobId, FinishedFile } from '@epicenter/blobs';
import type { Recording as RecordingRow, WhisperingData } from '../data';

/** New audio belongs to the row; older rows retain their validated blob id. */
export type Recording = Omit<RecordingRow, 'audioBlobId'> & {
	audioBlobId: BlobId | null;
};

/** Ordinary creation receives finished capture output or an imported file. */
export type NewRecording = Omit<
	Parameters<WhisperingData['tables']['recordings']['create']>[0],
	| 'audioBlobId'
	| 'audio'
	| 'uploadedAt'
	| 'transcriptionStatus'
	| 'transcriptionCompletedAt'
	| 'transcriptionError'
> & { audio: FinishedFile };

/** The one boundary where a stored row becomes an app recording. */
export function asRecording(row: RecordingRow): Recording {
	return row as Recording;
}
