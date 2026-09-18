import type {
	BlobId,
	BlobNotFound,
	BlobSource,
	BlobSourceFailed,
	BlobStoreFailed,
	RemoteBlobsError,
} from '@epicenter/blobs';
import type { NonconformingRow } from '@epicenter/data';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';
import type { WhisperingAppHandle, WhisperingData } from './app.js';
import { asRecording, type NewRecording, type Recording } from './recording.js';
export type RecordingAudioAvailability = 'local' | 'remote' | 'unavailable';

export const RecordingCreationError = defineErrors({
	/** The row could not be created; the independently saved bytes remain. */
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

export type WhisperingRecordings = {
	readonly sorted: Recording[];
	readonly count: number;
	readonly nonconforming: NonconformingRow[];
	get(id: Recording['id']): Recording | undefined;
	readAudio(
		id: Recording['id'],
	): Promise<Result<Blob, BlobNotFound | BlobStoreFailed | RemoteBlobsError>>;
	openAudio(
		id: Recording['id'],
	): Promise<
		Result<
			BlobSource,
			BlobNotFound | BlobStoreFailed | BlobSourceFailed | RemoteBlobsError
		>
	>;
	create(
		value: NewRecording,
	): Promise<Result<Recording, RecordingCreationError>>;
	patch(
		id: Recording['id'],
		partial: Partial<Omit<Recording, 'id'>>,
	): Recording;
	delete(
		toDelete: Recording['id'] | Recording['id'][],
	): Promise<Result<void, never>>;
	audioAvailability(
		id: Recording['id'],
	): Promise<Result<RecordingAudioAvailability, BlobStoreFailed>>;
	subscribe(listener: () => void): () => void;
};

/** Recording rows reference local bytes and explicitly uploaded URLs. */
export function createWhisperingRecordings(
	app: { tables: WhisperingData['tables']; blobs: WhisperingAppHandle['blobs'] },
) {
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
		const listed = app.tables.recordings;
		rows = listed.rows.map(asRecording);
		sorted = sortRows(rows);
		nonconforming = listed.nonconforming;
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
	// synchronized row changes.
	const unsubscribeRecords = app.tables.recordings.subscribe(read);
	async function readAudio(id: Recording['id']) {
		const row = resolve(id);
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
	async function openAudio(id: Recording['id']) {
		const row = resolve(id);
		if (!row) throw new Error(`Recording '${id}' no longer exists.`);
		const local = await app.blobs.local.open(row.audioBlobId);
		if (
			local.error?.name !== 'BlobNotFound' ||
			!row.audioUrl ||
			!app.blobs.remote
		)
			return local;
		return app.blobs.remote.open(row.audioUrl);
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
			// Bytes are already saved. Row failure never removes them.
			if (disposed) throw new Error('The recording session is closed.');
			const input = {
				...value,
				title: '',
				transcript: '',
				polishedTranscript: null,
				audioUrl: null,
				transcriptionStatus: 'pending',
				transcriptionCompletedAt: null,
				transcriptionError: null,
			};
			return trySync({
				try: () => asRecording(app.tables.recordings.create(input)),
				catch: (cause) =>
					RecordingCreationError.RowCreateFailed({
						audioBlobId: value.audioBlobId,
						cause,
					}),
			});
		},
		patch(id, partial) {
			const { id: _id, ...changes } = partial as Partial<Recording>;
			const written = app.tables.recordings.update(id, changes);
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
			for (const id of ids) app.tables.recordings.delete(id);
			return Ok(undefined);
		},
		async audioAvailability(id) {
			const row = resolve(id);
			if (!row?.audioBlobId) return Ok('unavailable');
			const result = await app.blobs.local.stat(row.audioBlobId);
			if (result.error === null) return Ok('local');
			if (result.error.name === 'BlobNotFound')
				return Ok(
					row.audioUrl && 'remote' in app.blobs ? 'remote' : 'unavailable',
				);
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
