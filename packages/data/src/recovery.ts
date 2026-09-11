/**
 * Unmounted library backup coordinator. The application-side codec validates
 * content; the stable authority publishes only after immutable storage read-back.
 *
 * Publication intent is durable. A capture is decided, written to the journal
 * with its exact bytes, and only then sent, so a page that dies between the
 * object write and the catalog row comes back able to finish the same
 * publication rather than starting a different one. Calling `backup()` again
 * after that interruption retries the original capture even though writes have
 * been accepted since; retrying an import requires the same file.
 *
 * Destructive restore is a separate checkpoint. There is no `restore`, and
 * nothing here is mounted: no transport, no barrel export, no screen. The
 * durable halves a future `restore` will sequence live under `attempts`, which
 * is private infrastructure rather than a sixth method.
 */
import {
	type BlobId,
	type BlobNotFound,
	type BlobStore,
	type BlobStoreFailed,
	generateBlobId,
} from '@epicenter/blobs';
import { Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';
import {
	ArchiveError,
	type ArchiveIdentity,
	captureArchive,
	prepareArchive,
} from './artifact/archive.js';
import { storeVerifiedBlob } from './artifact/archive-storage.js';
import type {
	JournalError,
	PublicationIntent,
	RecoveryJournal,
	RestoreIntent,
} from './recovery-journal.js';
import { type RestoreAttempt, RestoreError } from './sync/attempts.js';
import type { CurrentAuthority } from './sync/authority.js';
import { BackupError, type BackupRecord, digestHex } from './sync/backups.js';

/** A publication can also be refused because a restore holds the library's slot. */
type PublishError = ArchiveError | BackupError | JournalError | RestoreError;
type AttemptError = PublishError | BlobNotFound | BlobStoreFailed;

const ACTIVATION_CONTENT_TYPE = 'application/octet-stream';

/**
 * An unresolved attempt as the authority and the local reference together
 * describe it. `intent` is absent when another coordinator started it.
 */
type ReconciledAttempt = {
	attempt: RestoreAttempt;
	intent: RestoreIntent | undefined;
	receipt: ReturnType<CurrentAuthority['receipt']>;
};

export function createLibraryRecovery({
	authority,
	library,
	identity,
	blobs,
	archives,
	journal,
}: {
	authority: CurrentAuthority;
	library: string;
	identity: ArchiveIdentity;
	blobs: Pick<BlobStore, 'get'>;
	archives: Pick<BlobStore, 'put' | 'get'>;
	/** Durable, addressed to this library, and outside the replica it may replace. */
	journal: RecoveryJournal;
}) {
	identity = { ...identity };
	const backups = authority.backups({ library, identity, archives });
	const journalled = authority.attempts({ library, identity });
	/**
	 * One mutating operation at a time across the whole coordinator.
	 *
	 * The journal is a single slot, so two operations in flight can overwrite
	 * each other's intent: a publication awaiting its catalog row is exactly
	 * when a restore would replace the payload holding its only copy of the
	 * capture. This closes that inside one lifetime. Two coordinators over one
	 * address are arbitrated by the authority for attempts, and are still able
	 * to race a publication; binding recovery to the page lifetime, with a lock
	 * on the journal address, belongs to the checkpoint that mounts it.
	 */
	let running = false;
	function busy() {
		return BackupError.BackupFailed({
			cause: 'A recovery operation is running',
		});
	}

	async function metadata(bytes: Uint8Array) {
		const prepared = await prepareArchive(bytes);
		if (prepared.error !== null) return prepared;
		if (
			prepared.data.identity.appId !== identity.appId ||
			prepared.data.identity.dataId !== identity.dataId
		)
			return ArchiveError.InvalidArchive({
				cause: 'Archive belongs to another application or data definition',
			});
		return Ok({
			...prepared.data.identity,
			version: prepared.data.version,
			source: prepared.data.source,
		});
	}

	/**
	 * What this library still owes, read before any new action is started.
	 *
	 * An unresolved restore holds the slot too. Publishing under it would leave
	 * two intents whose retries could not be told apart, so a backup or import
	 * is refused by name until that attempt is reconciled.
	 */
	async function resume(): Promise<
		Result<
			PublicationIntent | undefined,
			BackupError | RestoreError | JournalError
		>
	> {
		// The authority is asked first. A restore started by another coordinator,
		// or by this one before its site data was cleared, holds the library's
		// slot whether or not anything local remembers it, and a journal that has
		// forgotten is not evidence that nothing is unresolved.
		const unresolved = journalled.pending();
		if (unresolved.error !== null) return unresolved;
		if (unresolved.data !== undefined)
			return RestoreError.AttemptPending({
				operation: unresolved.data.operation,
			});
		const loaded = await journal.load();
		if (loaded.error !== null) return loaded;
		if (loaded.data?.kind === 'restore')
			return RestoreError.AttemptPending({
				operation: loaded.data.operation,
			});
		return Ok(loaded.data);
	}

	/**
	 * The authority's answer, joined to whatever local reference agrees with it.
	 *
	 * Unguarded, so the guarded methods can compose it. Only the one case where
	 * nothing was ever started clears the reference.
	 */
	async function reconcile(): Promise<
		Result<ReconciledAttempt | undefined, AttemptError>
	> {
		const unresolved = journalled.pending();
		if (unresolved.error !== null) return unresolved;
		const loaded = await journal.load();
		if (loaded.error !== null) return loaded;
		const intent = loaded.data?.kind === 'restore' ? loaded.data : undefined;
		const operation = unresolved.data?.operation ?? intent?.operation;
		if (operation === undefined) return Ok(undefined);
		const held = journalled.get(operation);
		if (held.error !== null) return held;
		if (held.data === undefined) {
			const cleared = await journal.clear();
			if (cleared.error !== null) return cleared;
			return Ok(undefined);
		}
		return Ok({
			attempt: held.data,
			intent: intent?.operation === operation ? intent : undefined,
			receipt: authority.receipt(operation),
		});
	}

	async function publish(
		bytes: Uint8Array,
		reason: 'manual' | 'imported',
		retained: PublicationIntent | undefined,
	): Promise<Result<BackupRecord, PublishError>> {
		let intent = retained;
		if (intent) {
			if (
				intent.reason !== reason ||
				intent.bytes.length !== bytes.length ||
				intent.bytes.some((byte, index) => byte !== bytes[index])
			)
				return BackupError.BackupFailed({
					cause: 'A different backup publication is pending',
				});
		} else {
			const verified = await metadata(bytes);
			if (verified.error !== null) return verified;
			intent = {
				kind: 'publication',
				id: generateBlobId(),
				reason,
				bytes,
				metadata: verified.data,
			};
			// Before the first mutating request, and before the id it reserves is
			// spent: a reservation whose bytes were never written is unrecoverable.
			const recorded = await journal.record(intent);
			if (recorded.error !== null) return recorded;
		}
		const published = await backups.publish(intent);
		if (published.error !== null) return published;
		// A failed release leaves a resolved intent that the next call republishes
		// idempotently, which is the safe direction to fail in.
		const cleared = await journal.clear();
		if (cleared.error !== null) return cleared;
		return published;
	}

	return {
		/** Capture accepted state once; retry a pending publication without recapture. */
		async backup(): Promise<
			Result<BackupRecord, PublishError | BlobNotFound | BlobStoreFailed>
		> {
			if (running) return busy();
			running = true;
			try {
				const retained = await resume();
				if (retained.error !== null) return retained;
				if (retained.data)
					return await publish(retained.data.bytes, 'manual', retained.data);
				const captured = trySync({
					try: () => authority.capture(),
					catch: (cause) => BackupError.BackupFailed({ cause }),
				});
				if (captured.error !== null) return captured;
				const archive = await captureArchive(captured.data, blobs, identity);
				if (archive.error !== null) return archive;
				return await publish(new Uint8Array(archive.data), 'manual', undefined);
			} finally {
				running = false;
			}
		},
		/** Save the file unchanged. Import never activates a generation. */
		async import(file: Blob): Promise<Result<BackupRecord, PublishError>> {
			if (running) return busy();
			running = true;
			try {
				const retained = await resume();
				if (retained.error !== null) return retained;
				const read = await tryAsync({
					try: async () => new Uint8Array(await file.arrayBuffer()),
					catch: (cause) => ArchiveError.InvalidArchive({ cause }),
				});
				if (read.error !== null) return read;
				return await publish(read.data, 'imported', retained.data);
			} finally {
				running = false;
			}
		},
		list() {
			return backups.list();
		},
		async download(
			id: BlobId,
		): Promise<Result<Uint8Array<ArrayBuffer>, ArchiveError | BackupError>> {
			const saved = await backups.download(id);
			if (saved.error !== null) return saved;
			const verified = await metadata(saved.data);
			if (verified.error !== null) return verified;
			return saved;
		},

		/**
		 * The durable half of a restore, with no `restore()` in front of it yet.
		 *
		 * Not part of the recovery API. ADR-0386's fifth method composes these and
		 * is deliberately absent until activation orchestration, its transport, and
		 * the Backups screen exist: an application that could start an attempt but
		 * not finish one is worse than an application that cannot start.
		 */
		attempts: {
			/**
			 * What is unresolved, reconciled against the authority.
			 *
			 * The authority is asked first, because it holds the slot. A local
			 * reference is only ever an addition to that answer: it carries the
			 * capture bytes the authority cannot hold, and it names the attempt a
			 * person started here. An entry naming an attempt the authority never
			 * reserved is a reference to nothing and is released. Everything else
			 * is returned, resolved or not, because an attempt that finished while
			 * the page was gone is exactly the one a person needs told about.
			 */
			async pending(): Promise<
				Result<ReconciledAttempt | undefined, AttemptError>
			> {
				if (running) return busy();
				running = true;
				try {
					return await reconcile();
				} finally {
					running = false;
				}
			},

			/**
			 * Drop the local reference once its outcome has been seen.
			 *
			 * Separate from `pending` on purpose: reading must not be what forgets.
			 * A page that reads the outcome and then dies before acting on it finds
			 * the same outcome again, and only a caller that has actually handled it
			 * releases the slot. An attempt still in flight cannot be acknowledged.
			 */
			async acknowledge(
				operation: string,
			): Promise<Result<RestoreAttempt, AttemptError>> {
				if (running) return busy();
				running = true;
				try {
					const held = journalled.get(operation);
					if (held.error !== null) return held;
					const attempt = held.data;
					if (attempt === undefined)
						return RestoreError.AttemptUnknown({ operation });
					if (attempt.status === 'pending')
						return RestoreError.AttemptPending({ operation });
					const loaded = await journal.load();
					if (loaded.error !== null) return loaded;
					if (
						loaded.data?.kind === 'restore' &&
						loaded.data.operation === operation
					) {
						const cleared = await journal.clear();
						if (cleared.error !== null) return cleared;
					}
					return Ok(attempt);
				} finally {
					running = false;
				}
			},

			/**
			 * A committed outcome, read without touching archive storage.
			 *
			 * This is the answer to "did it actually happen" when the object store
			 * is unreachable, which is exactly the situation a person is in when
			 * they reopen the page after a restore went quiet. A lost response is
			 * not evidence of a lost activation.
			 */
			outcome(operation: string) {
				const attempt = journalled.get(operation);
				if (attempt.error !== null) return attempt;
				return Ok({
					attempt: attempt.data,
					receipt: authority.receipt(operation),
				});
			},

			/**
			 * Claim the slot for one published backup, durably, before anything moves.
			 *
			 * The reservation comes before the local reference, and it is the
			 * durable record: it is atomic, it is scoped to this library, and it is
			 * what another coordinator sees. A crash between the two leaves an
			 * attempt with no local pointer, which `pending` finds anyway. Writing
			 * the pointer first would instead leave a reference to an attempt that
			 * was never reserved, refusing every later backup by the name of
			 * something that does not exist.
			 *
			 * Repeating the call with the same backup resumes; naming a different
			 * one while an attempt is unresolved is refused rather than queued,
			 * because two intents would make a later retry ambiguous.
			 */
			async begin(
				backupId: BlobId,
			): Promise<Result<RestoreAttempt, AttemptError>> {
				if (running) return busy();
				running = true;
				try {
					const resumed = await reconcile();
					if (resumed.error !== null) return resumed;
					if (resumed.data !== undefined) {
						const { attempt, intent } = resumed.data;
						// A resolved attempt still holding the reference is an outcome
						// nobody has acknowledged. Starting over would hide it.
						if (
							attempt.status !== 'pending' ||
							attempt.backupId !== backupId ||
							intent === undefined
						)
							return RestoreError.AttemptPending({
								operation: attempt.operation,
							});
						return Ok(attempt);
					}
					const loaded = await journal.load();
					if (loaded.error !== null) return loaded;
					if (loaded.data !== undefined)
						return BackupError.BackupFailed({
							cause: 'A backup publication is pending',
						});
					const catalog = backups.list();
					if (catalog.error !== null) return catalog;
					const selected = catalog.data.find(
						(record) => record.id === backupId,
					);
					if (selected === undefined)
						return BackupError.BackupNotFound({ id: backupId });
					const operation = generateBlobId();
					const reserved = journalled.reserve({
						operation,
						backupId,
						backupDigest: selected.digest,
					});
					if (reserved.error !== null) return reserved;
					const recorded = await journal.record({
						kind: 'restore',
						operation,
						backupId,
					});
					if (recorded.error !== null) return recorded;
					return reserved;
				} finally {
					running = false;
				}
			},

			/**
			 * Publish this attempt's one safety backup, or return the one it has.
			 *
			 * The capture is written to the journal before it is sent, so an
			 * interrupted publication resumes from the same destination bytes. A
			 * second capture would describe a later library than the one activation
			 * is going to compare, which is the difference between a safety backup
			 * and a backup taken at some point near the restore.
			 */
			async safetyBackup(
				operation: string,
			): Promise<Result<BackupRecord, AttemptError>> {
				if (running) return busy();
				running = true;
				try {
					const held = journalled.get(operation);
					if (held.error !== null) return held;
					const attempt = held.data;
					if (attempt === undefined)
						return RestoreError.AttemptUnknown({ operation });
					if (attempt.safetyBackupId !== undefined) {
						const catalog = backups.list();
						if (catalog.error !== null) return catalog;
						const published = catalog.data.find(
							(record) => record.id === attempt.safetyBackupId,
						);
						return published === undefined
							? BackupError.BackupNotFound({ id: attempt.safetyBackupId })
							: Ok(published);
					}
					if (attempt.status !== 'pending')
						return RestoreError.AttemptResolved({
							operation,
							status: attempt.status,
						});
					const loaded = await journal.load();
					if (loaded.error !== null) return loaded;
					const intent = loaded.data;
					if (intent?.kind !== 'restore' || intent.operation !== operation)
						return RestoreError.AttemptUnknown({ operation });
					let safety = intent.safety;
					if (safety === undefined) {
						const captured = trySync({
							try: () => authority.capture(),
							catch: (cause) => BackupError.BackupFailed({ cause }),
						});
						if (captured.error !== null) return captured;
						const archive = await captureArchive(
							captured.data,
							blobs,
							identity,
						);
						if (archive.error !== null) return archive;
						const bytes = new Uint8Array(archive.data);
						const verified = await metadata(bytes);
						if (verified.error !== null) return verified;
						safety = {
							id: generateBlobId(),
							reason: 'before-restore',
							metadata: verified.data,
							bytes,
						};
						const recorded = await journal.record({ ...intent, safety });
						if (recorded.error !== null) return recorded;
					}
					const published = await backups.publish(safety);
					if (published.error !== null) return published;
					const associated = journalled.associateSafetyBackup(
						operation,
						safety.id,
					);
					if (associated.error !== null) return associated;
					// The attempt names the record now, so the journal stops carrying it.
					const released = await journal.record({
						kind: 'restore',
						operation,
						backupId: intent.backupId,
					});
					if (released.error !== null) return released;
					return published;
				} finally {
					running = false;
				}
			},

			/**
			 * Retain the exact prepared activation bytes and the position they replace.
			 *
			 * Every reconstruction authors fresh Yjs operation identities, so bytes
			 * rebuilt on a retry are a different lineage. They are stored immutably
			 * and read back before the attempt points at them; the destination
			 * condition is the position the safety backup covered, never the source
			 * archive's own generation and head. An interruption between the write
			 * and the pin leaves an object nothing references, which is the
			 * tolerated direction to fail in.
			 */
			async pin(
				operation: string,
				bytes: Uint8Array,
			): Promise<Result<RestoreAttempt, AttemptError>> {
				if (running) return busy();
				running = true;
				try {
					const held = journalled.get(operation);
					if (held.error !== null) return held;
					const attempt = held.data;
					if (attempt === undefined)
						return RestoreError.AttemptUnknown({ operation });
					const digest = await digestHex(bytes);
					if (attempt.activationDigest !== undefined)
						return attempt.activationDigest === digest
							? Ok(attempt)
							: RestoreError.AttemptConflict({ operation });
					if (attempt.safetyBackupId === undefined)
						return RestoreError.RestoreFailed({
							cause:
								'Preparation requires this attempt to have published its safety backup',
						});
					const catalog = backups.list();
					if (catalog.error !== null) return catalog;
					const safety = catalog.data.find(
						(record) => record.id === attempt.safetyBackupId,
					);
					if (safety === undefined)
						return BackupError.BackupNotFound({ id: attempt.safetyBackupId });
					const activationObjectId = generateBlobId();
					const stored = await storeVerifiedBlob(
						archives,
						activationObjectId,
						new Blob([new Uint8Array(bytes)], {
							type: ACTIVATION_CONTENT_TYPE,
						}),
					);
					if (stored.error !== null) return stored;
					return journalled.pinPreparation(operation, {
						destination: safety.source,
						activationDigest: digest,
						activationObjectId,
					});
				} finally {
					running = false;
				}
			},

			/** The retained request, so a retry activates the same lineage it prepared. */
			async activationBytes(
				operation: string,
			): Promise<Result<Uint8Array<ArrayBuffer>, AttemptError>> {
				const held = journalled.get(operation);
				if (held.error !== null) return held;
				const attempt = held.data;
				if (attempt === undefined)
					return RestoreError.AttemptUnknown({ operation });
				if (
					attempt.activationObjectId === undefined ||
					attempt.activationDigest === undefined
				)
					return RestoreError.RestoreFailed({
						cause: 'This attempt has no retained activation request',
					});
				const saved = await archives.get(attempt.activationObjectId);
				if (saved.error !== null) return saved;
				const read = await tryAsync({
					try: async () => new Uint8Array(await saved.data.arrayBuffer()),
					catch: (cause) => RestoreError.RestoreFailed({ cause }),
				});
				if (read.error !== null) return read;
				return (await digestHex(read.data)) === attempt.activationDigest
					? read
					: RestoreError.RestoreFailed({
							cause: 'Retained activation bytes do not match the pinned digest',
						});
			},

			/**
			 * Finalize a definitive preparation failure and fence the attempt.
			 *
			 * The authority proves nothing committed and writes the fence in one
			 * transaction. The local reference stays until it is acknowledged, the
			 * same as any other outcome: a failure the person never saw is not a
			 * failure that has been dealt with, and the slot it holds is what makes
			 * them deal with it.
			 */
			fail(operation: string): Result<RestoreAttempt, RestoreError> {
				return journalled.fail(operation);
			},

			list() {
				return journalled.list();
			},
		},
	};
}
