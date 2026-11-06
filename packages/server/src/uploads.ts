/**
 * The upload ledger (ADR-0809): an attachment's bytes uploaded to a
 * repository are pending until a commit keeps them. An upload of bytes the
 * repository did not already store records a `blob_upload` row; a commit
 * (through sync or a push) that references them deletes it; and
 * `sweepPendingUploads` deletes the bytes of every upload still pending
 * after a day, and its row, with no walk over history. Bytes a commit kept,
 * or stored before the ledger, have no row and are never swept. Scheduling
 * the sweep is the deployment's.
 *
 * Presigned uploads (R2) go straight to storage, so the server records
 * none of them; they are kept forever, as before the ledger.
 */
import { sql } from 'drizzle-orm';
import type { Db } from './db/create-db.js';
import type { LfsStore } from './lfs/lfs-store.js';

export type UploadLedger = {
	/** Record `oid`, newly stored for `repositoryId`, as pending. */
	pending(repositoryId: string, oid: string): Promise<void>;
	/** A commit references these: they are kept. */
	keep(repositoryId: string, oids: readonly string[]): Promise<void>;
	/** Take every upload pending since before `cutoff` out of the ledger, answering them. */
	expire(cutoff: Date): Promise<{ repositoryId: string; oid: string }[]>;
};

/** The ledger in the `blob_upload` table. */
export function databaseUploadLedger(db: Db): UploadLedger {
	return {
		async pending(repositoryId, oid) {
			await db.execute(sql`
				insert into blob_upload (repository_id, oid)
				values (${repositoryId}, ${oid})
				on conflict (repository_id, oid) do nothing
			`);
		},
		async keep(repositoryId, oids) {
			if (oids.length === 0) return;
			await db.execute(sql`
				delete from blob_upload
				where repository_id = ${repositoryId}
					and oid in (${sql.join(
						oids.map((oid) => sql`${oid}`),
						sql`, `,
					)})
			`);
		},
		async expire(cutoff) {
			const { rows } = await db.execute<{
				repository_id: string;
				oid: string;
			}>(sql`
				delete from blob_upload
				where uploaded_at < ${cutoff.toISOString()}
				returning repository_id, oid
			`);
			return rows.map((row) => ({
				repositoryId: row.repository_id,
				oid: row.oid,
			}));
		},
	};
}

/** How long an upload stays pending before the sweep deletes it. */
export const PENDING_FOR_MS = 24 * 60 * 60 * 1000;

/**
 * Delete the bytes of every upload pending for longer than `pendingForMs`
 * before `now`, answering how many. A row is taken out of the ledger before
 * its bytes go, so a commit that keeps an upload the moment it expires finds
 * no row; the bytes it references are checked as stored before it lands.
 */
export async function sweepPendingUploads({
	ledger,
	lfs,
	now = new Date(),
	pendingForMs = PENDING_FOR_MS,
}: {
	ledger: UploadLedger;
	lfs: LfsStore;
	now?: Date;
	pendingForMs?: number;
}): Promise<number> {
	const expired = await ledger.expire(new Date(now.getTime() - pendingForMs));
	for (const { repositoryId, oid } of expired)
		await lfs.delete(repositoryId, oid);
	return expired.length;
}
