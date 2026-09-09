import {
	type BlobAlreadyExists,
	type BlobId,
	type BlobNotFound,
	type BlobRemoteFailed,
	type BlobStoreFailed,
	type RemoteBlobNotFound,
} from '@epicenter/blobs';
import type { AppBlobs } from '@epicenter/app';
import type { NonconformingRow } from '@epicenter/data';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';
import type { WhisperingData } from '../data';
import {
	asRecording,
	type NewRecording,
	type Recording,
} from './recording.js';
import {
	createRecordingAudio,
	type RecordingAudioAvailability,
	RecordingAudioError,
} from './recording-audio';

const log = createLogger('whispering/recordings');

export const RecordingCreationError = defineErrors({
	/** The owning table refused to publish the row after its copy attempt. */
	RowCreateFailed: ({
		audioBlobId,
		cause,
	}: {
		audioBlobId: Blob | BlobId;
		cause: unknown;
	}) => ({
		message: 'Could not create the recording.',
		audioBlobId,
		cause,
	}),
});
export type RecordingCreationError = InferErrors<typeof RecordingCreationError>;

/**
 * What one backup flight did. A flight reports, and the rows say
 * what is still owed.
 */
export type BackupReport = {
	/** Rows whose audio reached the account during this flight. */
	uploaded: number;
	/** Rows whose audio is not on this device, so this device cannot send it. */
	absent: number;
	/** Rows that failed and did not succeed in a later coalesced pass. */
	failed: number;
	/** The pass stopped early: the remote is unavailable, or two uploads in a row failed. */
	aborted: boolean;
};

export const RecordingDeletionError = defineErrors({
	DeletionFailed: ({
		recordingId,
		deletedRecordingIds,
		stage,
		cause,
	}: {
		recordingId: Recording['id'];
		deletedRecordingIds: Recording['id'][];
		stage: 'online-copy' | 'device-copy';
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
	readonly nonconforming: NonconformingRow[];
	/** Whether the environment currently has an online audio copy capability. */
	readonly remoteAvailable: boolean;
	get(id: Recording['id']): Recording | undefined;
	create(
		value: NewRecording,
	): Promise<Result<Recording, RecordingCreationError>>;
	patch(
		id: Recording['id'],
		partial: Partial<Omit<Recording, 'id' | 'audioBlobId' | 'uploadedAt'>>,
	): Recording;
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
	/**
	 * Backup, as a surface with a reconciler behind it.
	 *
	 * The rows are the queue: what is owed to the account is exactly the rows
	 * with `uploadedAt === null`, a persisted, replicated, per-row fact that no
	 * outbox, tombstone, or transfer log could improve on, and that survives
	 * every crash the same way the rows do. Every policy is the same `kick`
	 * with a different trigger, so eager against manual is not a choice this
	 * domain makes; a caller decides when.
	 */
	readonly backup: {
		/** Rows owed to the account, synchronously, wherever their audio is. */
		readonly pending: number;
		/**
		 * Send what this device holds and the account does not, newest first,
		 * one transfer at a time. Single-flight and coalescing: a kick during a
		 * pass schedules one more pass after it and resolves when that one is
		 * done too, so every caller's answer includes the rows it saw. It
		 * schedules no autonomous retries; another trigger requests the next pass.
		 */
		kick(options?: { refreshLocal?: boolean }): Promise<BackupReport>;
	};
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
	remoteConfigured,
}: {
	table: WhisperingData['tables']['recordings'];
	blobs: AppBlobs;
	/** Whether this app session has an account-backed remote authority. */
	remoteConfigured: boolean;
}) {
	let rows: Recording[] = [];
	let sorted: Recording[] = [];
	let nonconforming: NonconformingRow[] = [];
	let disposed = false;
	const knownAbsent = new Set<BlobId>();
	let localRevision = 0;
	function audioBecameLocal(id: BlobId) {
		localRevision += 1;
		knownAbsent.delete(id);
	}
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of listeners) listener();
	};

	const audio = createRecordingAudio({
		blobs,
		updateUploadedAt: async (id, uploadedAt) => {
			const written = table.update(id, { uploadedAt });
			// The marker is in the document the moment this returns, so a delete
			// that immediately follows an upload sees the uploaded state and
			// purges the online copy instead of orphaning it. `subscribe` refreshes
			// the cache on the same commit.
			return written;
		},
	});

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
		if (firstUploaded && !remoteConfigured) {
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
			const { error: blobError } = await blobs.removeLocal(
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
			// The row delete cannot fail: it reports only whether a row was there
			// to take, and an already-gone row is still truthfully deleted.
			table.delete(recording.id);
			deletedRecordingIds.push(recording.id);
		}
		return Ok(undefined);
	}

	/** The rows owed to the account, newest first, as of now. */
	const owed = () => sorted.filter(({ uploadedAt }) => uploadedAt === null);

	let inFlight: Promise<BackupReport> | undefined;
	let again = false;
	function kick({ refreshLocal = false } = {}): Promise<BackupReport> {
		// A click can discover bytes another tab wrote, even during this flight.
		if (refreshLocal) {
			knownAbsent.clear();
			localRevision += 1;
		}
		if (inFlight !== undefined) {
			again = true;
			return inFlight;
		}
		inFlight = (async () => {
			const uploaded = new Set<Recording['id']>();
			const absent = new Set<Recording['id']>();
			const failed = new Set<Recording['id']>();
			let aborted = false;
			do {
				again = false;
				if (disposed || !remoteConfigured) {
					aborted = true;
					break;
				}
				const candidates = owed().filter((row) => {
					if (!knownAbsent.has(row.audioBlobId)) return true;
					absent.add(row.id);
					return false;
				});
				const revision = localRevision;
				const stats =
					candidates.length === 0
						? []
						: await blobs.statMany(
								candidates.map((row) => row.audioBlobId),
							);
				if (disposed || !remoteConfigured) {
					aborted = true;
					break;
				}
				// Discovery already paid for the whole batch. Remember all confirmed
				// misses even if early upload failures stop the following walk.
				if (revision === localRevision) {
					for (const [index, row] of candidates.entries()) {
						if (stats[index]?.error?.name === 'BlobNotFound')
							knownAbsent.add(row.audioBlobId);
					}
				}
				let consecutiveFailures = 0;
				for (const [index, candidate] of candidates.entries()) {
					if (disposed || !remoteConfigured) {
						aborted = true;
						break;
					}
					const recording = resolve(candidate.id);
					if (recording === undefined || recording.uploadedAt !== null)
						continue;
					const stat = stats[index];
					if (stat === undefined)
						throw new Error('Blob batch stat omitted a requested id.');
					if (stat.error?.name === 'BlobNotFound') {
						absent.add(recording.id);
						continue;
					}
					const error = stat.error ?? (await audio.upload(recording)).error;
					if (error === null) {
						uploaded.add(recording.id);
						failed.delete(recording.id);
						absent.delete(recording.id);
						consecutiveFailures = 0;
						continue;
					}
					if (error.name === 'RemoteUnavailable') {
						aborted = true;
						break;
					}
					failed.add(recording.id);
					if (++consecutiveFailures >= 2) {
						aborted = true;
						break;
					}
				}
			} while (again && !aborted);
			return {
				uploaded: uploaded.size,
				absent: absent.size,
				failed: failed.size,
				aborted,
			};
		})().finally(() => {
			inFlight = undefined;
		});
		return inFlight;
	}

	read();
	// Rows are hydrated before construction. No discovery may cache an absence
	// until this claim attempt settles, including a partially successful attempt.
	// Registration is synchronous, does no I/O and never fires initially, so the
	// read above has already seen everything (ADR-0187). It fires for a local
	// write and for bytes that arrived from another device alike, which is what
	// retired every hand-maintained cache patch below.
	const unsubscribeRecords = table.subscribe(read);
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
		get remoteAvailable() {
			return remoteConfigured;
		},
		get(id) {
			return resolve(id);
		},
		async create(value) {
			// The owning table copies the attachment and compensates failed creation.
			// Whispering supplies recording defaults and translates the failure.
			if (disposed) throw new Error('The recording session is closed.');
			const { data: written, error } = await table.create({
				...value,
				audioBlobId: value.audioBlobId,
				uploadedAt: null,
				transcriptionStatus: 'pending',
				transcriptionCompletedAt: null,
				transcriptionError: null,
			});
			if (error !== null) {
				return RecordingCreationError.RowCreateFailed({
					audioBlobId: value.audioBlobId,
					cause: error,
				});
			}
			return Ok(asRecording(written));
		},
		patch(id, partial) {
			// Structural typing lets a whole row flow in as the partial, so drop
			// the protected keys at runtime: the audio workflows stay the only
			// writer of uploadedAt and audio identity stays immutable.
			const {
				id: _id,
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
			const reread = table.get(id);
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
			const selected = ids
				.map(resolve)
				.filter((recording) => recording !== undefined);
			return deleteResolved(selected);
		},
		async audioAvailability(id) {
			return withRecording(id, audio.availability);
		},
		async uploadAudio(id) {
			return withRecording(id, audio.upload);
		},
		async downloadAudio(id) {
			const recording = resolve(id);
			const result = await withRecording(id, audio.download);
			if (result.error === null && recording !== undefined)
				audioBecameLocal(recording.audioBlobId);
			return result;
		},
		async removeLocalAudio(id) {
			return withRecording(id, audio.removeLocal);
		},
		backup: {
			get pending() {
				return owed().length;
			},
			kick,
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
			again = false;
			knownAbsent.clear();
			unsubscribeRecords();
			listeners.clear();
		},
	};
}
