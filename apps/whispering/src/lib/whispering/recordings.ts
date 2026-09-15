import type { AppBlobs } from '@epicenter/app';
import {
	type BlobNotFound,
	type BlobSource,
	type BlobSourceFailed,
	type BlobStoreFailed,
	type FinishedFile,
	parseBlobId,
} from '@epicenter/blobs';
import type { AttachmentError, NonconformingRow } from '@epicenter/data';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { WhisperingData } from '../data';
import { asRecording, type NewRecording, type Recording } from './recording.js';
export type RecordingAudioAvailability = 'local-only' | 'unavailable';

export const RecordingCreationError = defineErrors({
	/** The owning table refused to publish the row after its copy attempt. */
	RowCreateFailed: ({
		audio,
		cause,
	}: {
		audio: FinishedFile;
		cause: unknown;
	}) => ({
		message:
			'Recording save was not confirmed. Reopen the library to check what was saved.',
		audio,
		cause,
	}),
});
export type RecordingCreationError = InferErrors<typeof RecordingCreationError>;

export type WhisperingRecordings = {
	readonly sorted: Recording[];
	readonly count: number;
	readonly nonconforming: NonconformingRow[];
	get(id: Recording['id']): Recording | undefined;
	readAudio(
		id: Recording['id'],
	): Promise<Result<Blob, BlobNotFound | BlobStoreFailed | AttachmentError>>;
	openAudio(
		id: Recording['id'],
	): Promise<
		Result<
			BlobSource,
			BlobNotFound | BlobStoreFailed | BlobSourceFailed | AttachmentError
		>
	>;
	create(
		value: NewRecording,
	): Promise<Result<Recording, RecordingCreationError>>;
	patch(
		id: Recording['id'],
		partial: Partial<
			Omit<Recording, 'id' | 'audio' | 'audioBlobId' | 'uploadedAt'>
		>,
	): Recording;
	delete(
		toDelete: Recording['id'] | Recording['id'][],
	): Promise<Result<void, never>>;
	audioAvailability(
		id: Recording['id'],
	): Promise<
		Result<RecordingAudioAvailability, BlobStoreFailed | AttachmentError>
	>;
	subscribe(listener: () => void): () => void;
};

/** Recording rows and local-only audio reads. The library owns byte transfers. */
export function createWhisperingRecordings({
	table,
	blobs,
}: {
	table: WhisperingData['tables']['recordings'];
	blobs: AppBlobs;
}) {
	let rows: Recording[] = [];
	let sorted: Recording[] = [];
	let nonconforming: NonconformingRow[] = [];
	let disposed = false;
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of listeners) listener();
	};

	/**
	 * Re-read the table whole.
	 *
	 * There is no generation counter, no in-flight guard and no retry loop.
	 * Those arbitrated between asynchronous reads that could land out of order,
	 * and a read is now a walk over a document already in memory (ADR-0215), so
	 * none of it can happen. There is also no optimistic cache write before a
	 * refresh: the write and the read see the same document, so there is no
	 * window to paper over.
	 */
	function read(): void {
		const listed = table;
		rows = listed.rows.map(asRecording);
		// Older rows have no attachment cell. Read their validated legacy fields
		// without rewriting the document or adopting those bytes into a new owner.
		const legacy = listed.nonconforming.filter(
			(row) =>
				row.raw.audio === undefined &&
				row.issues.every((issue) => issue.field === 'audio') &&
				typeof row.conforming.audioBlobId === 'string' &&
				parseBlobId(row.conforming.audioBlobId) !== undefined,
		);
		rows.push(
			...legacy.map((row) =>
				asRecording({
					...row.conforming,
					id: row.id,
					audio: null,
				} as Parameters<typeof asRecording>[0]),
			),
		);
		sorted = sortRows(rows);
		nonconforming = listed.nonconforming.filter(
			(row) => !legacy.some((old) => old.id === row.id),
		);
		notify();
	}

	function resolve(id: Recording['id']) {
		return rows.find((recording) => recording.id === id);
	}

	function sortRows(unsorted: Recording[]): Recording[] {
		return unsorted.toSorted(
			(left, right) =>
				new Date(right.recordedAt).getTime() -
				new Date(left.recordedAt).getTime(),
		);
	}

	read();
	// The initial read sees hydrated rows; subscriptions cover later local and
	// synchronized row changes. Byte arrival is observed through the library.
	const unsubscribeRecords = table.subscribe(read);
	async function readAudio(id: Recording['id']) {
		const row = resolve(id);
		if (row?.audioBlobId) return blobs.get(row.audioBlobId);
		return table.attachment(id).read();
	}
	async function openAudio(id: Recording['id']) {
		const row = resolve(id);
		if (row?.audioBlobId) return blobs.open(row.audioBlobId);
		return table.attachment(id).source();
	}
	const recordings: WhisperingRecordings = {
		readAudio,
		openAudio,
		get sorted() {
			return sorted;
		},
		get count() {
			return rows.length;
		},
		get nonconforming() {
			return nonconforming;
		},
		get(id) {
			return resolve(id);
		},
		async create(value) {
			// The library publishes bytes and persists the row. An unknown outcome
			// stays intact; Whispering never remints or deletes an unconfirmed save.
			if (disposed) throw new Error('The recording session is closed.');
			const input = {
				...value,
				audioBlobId: null,
				uploadedAt: null,
				transcriptionStatus: 'pending',
				transcriptionCompletedAt: null,
				transcriptionError: null,
			};
			const { data: written, error } = await table.create(input);
			if (error !== null) {
				return RecordingCreationError.RowCreateFailed({
					audio: value.audio,
					cause: error,
				});
			}
			return Ok(asRecording(written));
		},
		patch(id, partial) {
			// Structural typing lets a whole row flow in as the partial, so drop
			// the protected keys at runtime: legacy markers remain unchanged
			// and audio identity stays immutable.
			const {
				id: _id,
				audio: _audio,
				audioBlobId: _audioBlobId,
				uploadedAt: _uploadedAt,
				...changes
			} = partial as Partial<Recording>;
			const written = table.update(id, changes);
			if (written.error !== null) throw written.error;
			// The write reports only that it landed; what the row now reads as is
			// `get`'s answer. Subscriptions fired inside the write, so the cache is
			// already refreshed by the time this re-read runs.
			// `get` answers `undefined` for both a vanished row and one this
			// declaration can no longer read; after a write we just made, either is
			// the same bug and deserves the same throw.
			const reread = resolve(id);
			if (reread === undefined) {
				throw new Error(
					`Recording '${id}' no longer reads whole after this patch`,
				);
			}
			return asRecording(reread);
		},
		async delete(toDelete) {
			const ids = Array.isArray(toDelete) ? toDelete : [toDelete];
			// An unknown id is already gone; deletion is idempotent over it.
			for (const id of ids) table.delete(id);
			return Ok(undefined);
		},
		async audioAvailability(id) {
			const row = resolve(id);
			if (row && row.audioBlobId === null) {
				const result = await table.attachment(id).stat();
				if (result.error === null) return Ok('local-only');
				if (
					result.error.name === 'Unavailable' &&
					['incomplete', 'local-bytes', 'row-absent'].includes(
						result.error.reason,
					)
				)
					return Ok('unavailable');
				return Err(result.error);
			}
			if (!row?.audioBlobId) return Ok('unavailable');
			const result = await blobs.stat(row.audioBlobId);
			if (result.error === null) return Ok('local-only');
			if (result.error.name === 'BlobNotFound') return Ok('unavailable');
			return Err(result.error);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};

	return {
		recordings,
		[Symbol.dispose]() {
			disposed = true;
			unsubscribeRecords();
			listeners.clear();
		},
	};
}
