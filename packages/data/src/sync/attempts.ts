/**
 * Durable restore attempts under the current authority's SQLite owner.
 *
 * A restore spans several requests that can each be lost: publishing the safety
 * backup, uploading prepared activation bytes, and the activation itself. The
 * attempt row is what survives every one of those losses. It lives beside the
 * backup catalog rather than inside the replaceable generation log, so the
 * record of an in-flight restore is not erased by the restore it describes.
 *
 * One unresolved attempt per library, enforced by the database rather than by
 * the caller: a partial unique index over `status = 'pending'` means two
 * concurrent reservations cannot both believe they hold the slot.
 *
 * This owner reads `_restore_receipts` directly. That table and this one belong
 * to the same serialization boundary on purpose: finalizing a failure and
 * committing an activation must not be able to pass each other, so neither may
 * be resolved from outside the transaction that reads both.
 */
import { type BlobId, parseBlobId } from '@epicenter/blobs';
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result, trySync } from 'wellcrafted/result';
import { pinLibrary } from './backups.js';

/** `pending` holds the slot; `failed` fences late activation; `activated` is a committed outcome. */
export type RestoreAttemptStatus = 'pending' | 'failed' | 'activated';

export type RestoreAttempt = {
	operation: string;
	library: string;
	backupId: BlobId;
	backupDigest: string;
	/** The one safety backup this attempt published, once it has one. */
	safetyBackupId: BlobId | undefined;
	/** The destination position activation will compare, once preparation pinned it. */
	destination: { generation: number; head: number } | undefined;
	/** The digest of the exact prepared activation bytes, once preparation pinned them. */
	activationDigest: string | undefined;
	/** Where those exact bytes are retained, so a retry never reconstructs them. */
	activationObjectId: BlobId | undefined;
	status: RestoreAttemptStatus;
	startedAt: number;
};

export const RestoreError = defineErrors({
	RestoreFailed: ({ cause }: { cause: unknown }) => ({
		message: `Restore attempt operation failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/** Another attempt holds the library's single unresolved slot. */
	AttemptPending: ({ operation }: { operation: string }) => ({
		message: `Restore attempt '${operation}' is still unresolved`,
		operation,
	}),
	AttemptUnknown: ({ operation }: { operation: string }) => ({
		message: `No restore attempt '${operation}' in this library`,
		operation,
	}),
	/** The attempt exists but is no longer pending, so it cannot be advanced. */
	AttemptResolved: ({
		operation,
		status,
	}: {
		operation: string;
		status: RestoreAttemptStatus;
	}) => ({
		message: `Restore attempt '${operation}' already resolved as ${status}`,
		operation,
		status,
	}),
	/** A retry disagrees with the request the attempt durably retains. */
	AttemptConflict: ({ operation }: { operation: string }) => ({
		message: `Restore attempt '${operation}' retains a different request`,
		operation,
	}),
});
export type RestoreError = InferErrors<typeof RestoreError>;

export type AttemptRow = SqliteRow & {
	operation: string;
	backup_id: BlobId;
	backup_digest: string;
	safety_backup_id: BlobId | null;
	expected_generation: number | null;
	expected_head: number | null;
	activation_digest: string | null;
	activation_object_id: BlobId | null;
	status: RestoreAttemptStatus;
	started_at: number;
};

export function applyAttemptSchema(sqlite: SqliteDatabase): void {
	sqlite.run(`CREATE TABLE IF NOT EXISTS _restore_attempts (
		operation TEXT PRIMARY KEY,
		backup_id TEXT NOT NULL,
		backup_digest TEXT NOT NULL,
		safety_backup_id TEXT,
		expected_generation INTEGER,
		expected_head INTEGER,
		activation_digest TEXT,
		activation_object_id TEXT,
		status TEXT NOT NULL CHECK (status IN ('pending', 'failed', 'activated')),
		started_at INTEGER NOT NULL
	)`);
	// The single-slot rule, held by the database rather than by a read-then-write.
	sqlite.run(`CREATE UNIQUE INDEX IF NOT EXISTS _restore_attempts_unresolved
		ON _restore_attempts (status) WHERE status = 'pending'`);
}

/** Whether this operation already has a committed activation receipt. */
export function hasReceipt(sqlite: SqliteDatabase, operation: string): boolean {
	return (
		sqlite.all<SqliteRow>(
			'SELECT operation FROM _restore_receipts WHERE operation = ?',
			[operation],
		).length > 0
	);
}

export function readAttempt(
	sqlite: SqliteDatabase,
	operation: string,
): AttemptRow | undefined {
	return sqlite.all<AttemptRow>(
		'SELECT * FROM _restore_attempts WHERE operation = ?',
		[operation],
	)[0];
}

/**
 * Private attempt journal. The library binding is the SQLite owner itself, the
 * same one `_backup_library` pins, so an attempt cannot name another library.
 */
export function openAttempts({
	sqlite,
	library,
	identity,
}: {
	sqlite: SqliteDatabase;
	library: string;
	identity: { appId: string; dataId: string };
}) {
	pinLibrary({ sqlite, library, identity });
	applyAttemptSchema(sqlite);

	function attempt(row: AttemptRow): RestoreAttempt {
		return {
			operation: row.operation,
			library,
			backupId: row.backup_id,
			backupDigest: row.backup_digest,
			safetyBackupId: row.safety_backup_id ?? undefined,
			destination:
				row.expected_generation === null || row.expected_head === null
					? undefined
					: {
							generation: row.expected_generation,
							head: row.expected_head,
						},
			activationDigest: row.activation_digest ?? undefined,
			activationObjectId: row.activation_object_id ?? undefined,
			status: row.status,
			startedAt: row.started_at,
		};
	}
	function run<TValue>(
		operation: () => Result<TValue, RestoreError>,
	): Result<TValue, RestoreError> {
		const result = trySync({
			try: () => sqlite.transaction(operation),
			catch: (cause) => RestoreError.RestoreFailed({ cause }),
		});
		return result.error === null ? result.data : result;
	}
	/** Advance a row that must still be pending, or say precisely why it cannot be. */
	function advance(
		operation: string,
		apply: (row: AttemptRow) => Result<AttemptRow, RestoreError>,
	) {
		return run(() => {
			const row = readAttempt(sqlite, operation);
			if (row === undefined) return RestoreError.AttemptUnknown({ operation });
			if (row.status !== 'pending')
				return RestoreError.AttemptResolved({ operation, status: row.status });
			const applied = apply(row);
			if (applied.error !== null) return applied;
			return Ok(attempt(applied.data));
		});
	}

	return {
		/**
		 * Claim the library's single slot, or resume the identical attempt.
		 *
		 * Reserving with an operation that already exists is a retry, not a new
		 * request: it returns the retained attempt when the selected backup and
		 * digest match, conflicts when they do not, and reports the outcome when
		 * that attempt has already resolved. A different operation while one is
		 * pending is refused, which is what makes "reconcile before starting
		 * another" enforceable rather than advisory.
		 */
		reserve(request: {
			operation: string;
			backupId: BlobId;
			backupDigest: string;
		}): Result<RestoreAttempt, RestoreError> {
			const { operation } = request;
			return run(() => {
				if (
					operation.length === 0 ||
					!parseBlobId(request.backupId) ||
					request.backupDigest.length === 0
				)
					return RestoreError.RestoreFailed({
						cause: 'A restore attempt needs an operation, backup id and digest',
					});
				const held = readAttempt(sqlite, operation);
				if (held !== undefined) {
					if (
						held.backup_id !== request.backupId ||
						held.backup_digest !== request.backupDigest
					)
						return RestoreError.AttemptConflict({ operation });
					// A resolved attempt is an outcome to read, not a slot to hold.
					return held.status === 'pending'
						? Ok(attempt(held))
						: RestoreError.AttemptResolved({
								operation,
								status: held.status,
							});
				}
				const unresolved = sqlite.all<AttemptRow>(
					"SELECT * FROM _restore_attempts WHERE status = 'pending'",
				)[0];
				if (unresolved !== undefined)
					return RestoreError.AttemptPending({
						operation: unresolved.operation,
					});
				sqlite.run(
					'INSERT INTO _restore_attempts VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)',
					[
						operation,
						request.backupId,
						request.backupDigest,
						'pending',
						Date.now(),
					],
				);
				const inserted = readAttempt(sqlite, operation);
				if (inserted === undefined)
					return RestoreError.RestoreFailed({
						cause: 'Restore attempt reservation disappeared',
					});
				return Ok(attempt(inserted));
			});
		},

		/**
		 * Bind the one safety backup this attempt is allowed to have.
		 *
		 * Set once. A response lost after publication finds the same id here on
		 * restart, which is the whole reason a second destination capture is never
		 * needed: the backup taken before this attempt is the backup that stays
		 * associated with it, whether or not activation ever commits.
		 */
		associateSafetyBackup(
			operation: string,
			safetyBackupId: BlobId,
		): Result<RestoreAttempt, RestoreError> {
			return advance(operation, (row) => {
				if (!parseBlobId(safetyBackupId))
					return RestoreError.RestoreFailed({
						cause: 'A safety backup needs a blob id',
					});
				if (row.safety_backup_id !== null)
					return row.safety_backup_id === safetyBackupId
						? Ok(row)
						: RestoreError.AttemptConflict({ operation });
				sqlite.run(
					'UPDATE _restore_attempts SET safety_backup_id = ? WHERE operation = ? AND safety_backup_id IS NULL',
					[safetyBackupId, operation],
				);
				const updated = readAttempt(sqlite, operation);
				return updated === undefined
					? RestoreError.AttemptUnknown({ operation })
					: Ok(updated);
			});
		},

		/**
		 * Pin the destination condition and the digest of the exact prepared bytes.
		 *
		 * Every reconstruction authors fresh Yjs operation identities, so a retry
		 * that rebuilt the archive would be a different lineage wearing the same
		 * intent. Pinning the digest here is what lets activation refuse that.
		 */
		pinPreparation(
			operation: string,
			preparation: {
				destination: { generation: number; head: number };
				activationDigest: string;
				activationObjectId: BlobId;
			},
		): Result<RestoreAttempt, RestoreError> {
			return advance(operation, (row) => {
				const { generation, head } = preparation.destination;
				if (
					![generation, head].every(
						(value) => Number.isSafeInteger(value) && value > 0,
					) ||
					preparation.activationDigest.length === 0 ||
					!parseBlobId(preparation.activationObjectId)
				)
					return RestoreError.RestoreFailed({
						cause:
							'Preparation needs a destination position, activation digest and retained object',
					});
				if (row.activation_digest !== null || row.expected_generation !== null)
					return row.activation_digest === preparation.activationDigest &&
						row.activation_object_id === preparation.activationObjectId &&
						row.expected_generation === generation &&
						row.expected_head === head
						? Ok(row)
						: RestoreError.AttemptConflict({ operation });
				sqlite.run(
					`UPDATE _restore_attempts
					 SET expected_generation = ?, expected_head = ?,
					     activation_digest = ?, activation_object_id = ?
					 WHERE operation = ? AND activation_digest IS NULL`,
					[
						generation,
						head,
						preparation.activationDigest,
						preparation.activationObjectId,
						operation,
					],
				);
				const updated = readAttempt(sqlite, operation);
				return updated === undefined
					? RestoreError.AttemptUnknown({ operation })
					: Ok(updated);
			});
		},

		/**
		 * Finalize a definitive preparation failure and release the slot.
		 *
		 * The same transaction proves no activation committed and writes the fence,
		 * so a request already in flight cannot land afterwards: activation reads
		 * this status before it compares the destination. An operation that did
		 * commit is refused here rather than rewritten, because its outcome is a
		 * fact about the library, not a state this coordinator gets to choose.
		 */
		fail(operation: string): Result<RestoreAttempt, RestoreError> {
			return advance(operation, () => {
				if (hasReceipt(sqlite, operation))
					return RestoreError.AttemptResolved({
						operation,
						status: 'activated',
					});
				sqlite.run(
					"UPDATE _restore_attempts SET status = 'failed' WHERE operation = ? AND status = 'pending'",
					[operation],
				);
				const updated = readAttempt(sqlite, operation);
				return updated === undefined
					? RestoreError.AttemptUnknown({ operation })
					: Ok(updated);
			});
		},

		/** The attempt holding the slot, if any. */
		pending(): Result<RestoreAttempt | undefined, RestoreError> {
			return run(() => {
				const row = sqlite.all<AttemptRow>(
					"SELECT * FROM _restore_attempts WHERE status = 'pending'",
				)[0];
				return Ok(row === undefined ? undefined : attempt(row));
			});
		},

		get(operation: string): Result<RestoreAttempt | undefined, RestoreError> {
			return run(() => {
				const row = readAttempt(sqlite, operation);
				return Ok(row === undefined ? undefined : attempt(row));
			});
		},

		list(): Result<RestoreAttempt[], RestoreError> {
			return run(() =>
				Ok(
					sqlite
						.all<AttemptRow>(
							'SELECT * FROM _restore_attempts ORDER BY started_at DESC, operation',
						)
						.map(attempt),
				),
			);
		},
	};
}
