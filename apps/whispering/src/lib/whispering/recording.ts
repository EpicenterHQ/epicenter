/**
 * One recording as the app uses it: the row, with its audio id carrying the
 * brand the blob store requires.
 *
 * The workspace cannot express the brand. It declares `audioBlobId` as
 * `/^blob_[a-z0-9]{21}$/`, which is `BLOB_ID_ROUTE_REGEX` anchored: the exact
 * pattern `BlobId` validates and `generateBlobId` is locked to by a round-trip
 * test. What `RowOf` yields from it is the template literal type, which is the
 * same set of strings without the nominal marker.
 *
 * So this module restores a fact TypeScript lost rather than asserting a new
 * one, and it is the only place that does. Running `parseBlobId` here instead
 * would re-run the regex the store just ran on the way out of the projection,
 * and hand back an `undefined` no caller could act on: a stored value that did
 * not match would have failed conformance and arrived as a nonconforming
 * diagnostic, never as a row.
 */

import type { BlobId } from '@epicenter/blobs';
import type { Recording as RecordingRow, WhisperingData } from '../data';

export type Recording = Omit<RecordingRow, 'audioBlobId'> & {
	audioBlobId: BlobId;
};

/**
 * What creating a recording needs.
 *
 * The application's create input. The recording domain initializes its
 * transcription columns explicitly. `uploadedAt` is withheld because the audio workflows are its
 * only writer, and `audioBlobId` carries the brand for the same reason
 * {@link Recording} does. A native capture passes its source BlobId; the owning
 * table copies it to the row's fresh immutable id and leaves the source cleanup
 * to the capture workflow.
 */
export type NewRecording = Omit<
	Parameters<WhisperingData['tables']['recordings']['create']>[0],
	| 'audioBlobId'
	| 'uploadedAt'
	| 'transcriptionStatus'
	| 'transcriptionCompletedAt'
	| 'transcriptionError'
> & { audioBlobId: Blob | BlobId };

/** The one boundary where a stored row becomes an app recording. */
export function asRecording(row: RecordingRow): Recording {
	return row as Recording;
}

/**
 * The other direction, for a write.
 *
 * Needed separately because a brand is not a subtype of the pattern: an
 * intersection with a phantom marker says nothing to TypeScript about which
 * strings it contains. Same one fact, crossing the same boundary the other way,
 * so it lives beside {@link asRecording} rather than at the write site.
 */
