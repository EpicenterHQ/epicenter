import {
	type BlobAlreadyExists,
	type BlobId,
	type BlobNotFound,
	type BlobRemoteFailed,
	type BlobStoreFailed,
	generateBlobId,
	type RemoteBlobNotFound,
} from '@epicenter/blobs';
import type { NonconformingRowError, TableLens } from '@epicenter/data';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { Recording, recordingsTable } from '../workspace';
import {
	createRecordingAudio,
	type RecordingAudioAvailability,
	RecordingAudioError,
	type WhisperingBlobs,
} from './recording-audio';

export const RecordingDeletionError = defineErrors({
	RowDeleteFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not delete the recording row: ${extractErrorMessage(cause)}`,
		cause,
	}),
	DeletionFailed: ({
		recordingId,
		deletedRecordingIds,
		stage,
		cause,
	}: {
		recordingId: Recording['id'];
		deletedRecordingIds: Recording['id'][];
		stage: 'online-copy' | 'device-copy' | 'recording-row';
		cause: unknown;
	}) => ({
		message:
			deletedRecordingIds.length === 0
				? `Could not delete this recording's ${stage}.`
				: `Deleted ${deletedRecordingIds.length} recording(s), then could not delete the next ${stage}.`,
		recordingId,
		deletedRecordingIds,
		stage,
		cause,
	}),
});
export type RecordingDeletionError = InferErrors<typeof RecordingDeletionError>;

export type WhisperingRecordings = {
	readonly sorted: Recording[];
	readonly count: number;
	readonly nonconforming: NonconformingRowError[];
	readonly loadError: unknown;
	/** Whether the environment currently has an online audio copy capability. */
	readonly remoteAvailable: boolean;
	get(id: Recording['id']): Recording | undefined;
	/** Mint an opaque id and commit captured bytes before any row exists. */
	storeAudio(
		blob: Blob,
	): Promise<
		Result<
			{ audioBlobId: BlobId; byteLength: number },
			BlobAlreadyExists | BlobStoreFailed
		>
	>;
	create(value: Omit<Recording, 'id' | 'uploadedAt'>): Promise<Recording>;
	update(
		id: Recording['id'],
		partial: Partial<Omit<Recording, 'id' | 'audioBlobId' | 'uploadedAt'>>,
	): ReturnType<TableLens<typeof recordingsTable>['update']>;
	delete(
		toDelete: Recording['id'] | Recording['id'][],
	): Promise<Result<void, RecordingAudioError | RecordingDeletionError>>;
	audioAvailability(
		id: Recording['id'],
	): Promise<
		Result<RecordingAudioAvailability, BlobStoreFailed | RecordingAudioError>
	>;
	uploadAudio(
		id: Recording['id'],
	): Promise<
		Result<
			void,
			BlobNotFound | BlobStoreFailed | BlobRemoteFailed | RecordingAudioError
		>
	>;
	downloadAudio(
		id: Recording['id'],
	): Promise<
		Result<
			void,
			| RemoteBlobNotFound
			| BlobStoreFailed
			| BlobRemoteFailed
			| RecordingAudioError
		>
	>;
	removeLocalAudio(
		id: Recording['id'],
	): Promise<
		Result<
			void,
			BlobNotFound | BlobStoreFailed | BlobRemoteFailed | RecordingAudioError
		>
	>;
	refresh(): Promise<void>;
	subscribe(listener: () => void): () => void;
};

/**
 * The recordings domain: the hydrated row cache plus every workflow that must
 * keep a recording row and its audio blob consistent. This module is the only
 * writer of `uploadedAt` (through the audio workflows), and `delete` is the
 * one deletion path: online copy, then device copy, then row.
 */
export function createWhisperingRecordings({
	table,
	blobs,
	reportBackgroundError,
}: {
	table: TableLens<typeof recordingsTable>;
	blobs: WhisperingBlobs;
	reportBackgroundError(cause: unknown): void;
}) {
	let rows: Recording[] = [];
	let sorted: Recording[] = [];
	let nonconforming: NonconformingRowError[] = [];
	let loadError: unknown = null;
	let refreshGeneration = 0;
	let isDisposed = false;
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of listeners) listener();
	};

	const audio = createRecordingAudio({
		blobs,
		updateUploadedAt: async (id, uploadedAt) => {
			const result = await table.update(id, {
				uploadedAt,
			});
			// Write the marker through to the cache before this workflow resolves,
			// so a delete that immediately follows an upload sees the uploaded
			// state and purges the online copy instead of orphaning it.
			if (result.error === null && result.data !== undefined) {
				applyRowToCache(result.data as Recording);
			}
			void refresh();
			return result;
		},
	});

	async function refresh({ rethrow = false }: { rethrow?: boolean } = {}) {
		refreshGeneration += 1;
		while (!isDisposed) {
			const generation = refreshGeneration;
			try {
				const { rows: nextRows, nonconforming: nextNonconforming } =
					await table.scan();
				if (isDisposed) return;
				if (generation !== refreshGeneration) continue;
				rows = nextRows as Recording[];
				sorted = sortRows(rows);
				nonconforming = nextNonconforming;
				loadError = null;
				notify();
			} catch (cause) {
				if (isDisposed) return;
				if (generation !== refreshGeneration) continue;
				loadError = cause;
				notify();
				if (rethrow) throw cause;
				reportBackgroundError(cause);
			}
			return;
		}
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

	/** Reflect one committed write in the cache before the refresh lands. */
	function applyRowToCache(row: Recording) {
		rows = rows.some((existing) => existing.id === row.id)
			? rows.map((existing) => (existing.id === row.id ? row : existing))
			: [...rows, row];
		sorted = sortRows(rows);
		notify();
	}

	/** Reflect one committed deletion in the cache before the refresh lands. */
	function removeRowFromCache(id: Recording['id']) {
		rows = rows.filter((row) => row.id !== id);
		sorted = sortRows(rows);
		notify();
	}

	/**
	 * Resolve the current row for one audio workflow so blob state (especially
	 * `uploadedAt`) is read from the cache at execution time, not from a caller
	 * snapshot that may predate a concurrent upload.
	 */
	function withRecording<TValue, TError>(
		id: Recording['id'],
		run: (
			recording: Recording,
		) => Promise<Result<TValue, TError | RecordingAudioError>>,
	): Promise<Result<TValue, TError | RecordingAudioError>> {
		const recording = resolve(id);
		if (recording === undefined) {
			return Promise.resolve(
				RecordingAudioError.RecordingNotFound({ recordingId: id }),
			);
		}
		return run(recording);
	}

	async function deleteResolved(
		selected: Recording[],
	): Promise<Result<void, RecordingAudioError | RecordingDeletionError>> {
		// Remote availability is preflighted for the whole selection. Each
		// recording then commits sequentially: online copy, device copy, row. If a
		// later item fails, earlier rows are already truthfully gone and the typed
		// error reports the completed prefix.
		const firstUploaded = selected.find(
			({ uploadedAt }) => uploadedAt !== null,
		);
		if (firstUploaded && blobs.remote === null) {
			return RecordingAudioError.RemoteUnavailable({
				recordingId: firstUploaded.id,
			});
		}
		const deletedRecordingIds: Recording['id'][] = [];
		for (const recording of selected) {
			const { error: purgeError } = await audio.purge(recording);
			if (purgeError !== null) {
				return RecordingDeletionError.DeletionFailed({
					recordingId: recording.id,
					deletedRecordingIds,
					stage: 'online-copy',
					cause: purgeError,
				});
			}
			const { error: blobError } = await blobs.local.delete(
				recording.audioBlobId,
			);
			if (blobError !== null) {
				return RecordingDeletionError.DeletionFailed({
					recordingId: recording.id,
					deletedRecordingIds,
					stage: 'device-copy',
					cause: blobError,
				});
			}
			const { error: rowError } = await tryAsync({
				try: async () => {
					if (!(await table.delete(recording.id))) {
						throw new Error(`Recording row ${recording.id} was already absent`);
					}
				},
				catch: (cause) => RecordingDeletionError.RowDeleteFailed({ cause }),
			});
			if (rowError !== null) {
				return RecordingDeletionError.DeletionFailed({
					recordingId: recording.id,
					deletedRecordingIds,
					stage: 'recording-row',
					cause: rowError,
				});
			}
			deletedRecordingIds.push(recording.id);
			removeRowFromCache(recording.id);
		}
		return Ok(undefined);
	}

	const unsubscribeRecords = table.subscribe(() => void refresh());
	const ready = refresh({ rethrow: true });
	const recordings: WhisperingRecordings = {
		get sorted() {
			return sorted;
		},
		get count() {
			return rows.length;
		},
		get nonconforming() {
			return nonconforming;
		},
		get loadError() {
			return loadError;
		},
		get remoteAvailable() {
			return blobs.remote !== null;
		},
		get(id) {
			return resolve(id);
		},
		async storeAudio(blob) {
			const audioBlobId = generateBlobId();
			const result = await blobs.local.put(audioBlobId, blob);
			if (result.error !== null) return result;
			return Ok({ audioBlobId, byteLength: blob.size });
		},
		async create(value) {
			let created: Recording;
			try {
				created = (await table.create({
					...value,
					uploadedAt: null,
				})) as Recording;
			} catch (cause) {
				// The row never existed, so the already-committed audio is orphaned:
				// remove it rather than leaking unreachable bytes.
				const { error: cleanupError } = await blobs.local.delete(
					value.audioBlobId,
				);
				if (cleanupError !== null) {
					throw new AggregateError(
						[cause, cleanupError],
						'Could not create the recording row or clean up its stored audio.',
					);
				}
				throw cause;
			}
			// Insert optimistically so follow-up workflows (auto-upload, delete)
			// resolve the new row before the background refresh lands.
			applyRowToCache(created);
			void refresh();
			return created;
		},
		async update(id, partial) {
			// Structural typing lets a whole row flow in as the partial, so drop
			// the protected keys at runtime: the audio workflows stay the only
			// writer of uploadedAt and audio identity stays immutable.
			const {
				id: _id,
				audioBlobId: _audioBlobId,
				uploadedAt: _uploadedAt,
				...changes
			} = partial as Partial<Recording>;
			const result = await table.update(id, changes);
			if (result.error === null && result.data !== undefined) {
				applyRowToCache(result.data as Recording);
			}
			void refresh();
			return result;
		},
		async delete(toDelete) {
			const ids = Array.isArray(toDelete) ? toDelete : [toDelete];
			// An unknown id is already gone; deletion is idempotent over it.
			const selected = ids
				.map(resolve)
				.filter((recording) => recording !== undefined);
			const result = await deleteResolved(selected);
			void refresh();
			return result;
		},
		audioAvailability(id) {
			return withRecording(id, audio.availability);
		},
		uploadAudio(id) {
			return withRecording(id, audio.upload);
		},
		downloadAudio(id) {
			return withRecording(id, audio.download);
		},
		removeLocalAudio(id) {
			return withRecording(id, audio.removeLocal);
		},
		refresh,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};

	return {
		recordings,
		ready,
		dispose() {
			isDisposed = true;
			refreshGeneration += 1;
			unsubscribeRecords();
			listeners.clear();
		},
	};
}
