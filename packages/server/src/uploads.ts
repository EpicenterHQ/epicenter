/**
 * The upload ledger (ADR-0809): an attachment's bytes uploaded to a
 * folder are pending until a commit keeps them. An upload of bytes the
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
	/** Record `oid`, newly stored for `folder`, as pending. */
	pending(folder: string, oid: string): Promise<void>;
	/** A commit references these: they are kept. */
	keep(folder: string, oids: readonly string[]): Promise<void>;
	/** Take every upload pending since before `cutoff` out of the ledger, answering them. */
	expire(cutoff: Date): Promise<{ folder: string; oid: string }[]>;
};

/** The ledger in the `blob_upload` table. */
export function databaseUploadLedger(db: Db): UploadLedger {
	return {
		async pending(folder, oid) {
			await db.execute(sql`
				insert into blob_upload (folder_id, oid)
				values (${folder}, ${oid})
				on conflict (folder_id, oid) do nothing
			`);
		},
		async keep(folder, oids) {
			if (oids.length === 0) return;
			await db.execute(sql`
				delete from blob_upload
				where folder_id = ${folder}
					and oid in (${sql.join(
						oids.map((oid) => sql`${oid}`),
						sql`, `,
					)})
			`);
		},
		async expire(cutoff) {
			const { rows } = await db.execute<{
				folder_id: string;
				oid: string;
			}>(sql`
				delete from blob_upload
				where uploaded_at < ${cutoff.toISOString()}
				returning folder_id, oid
			`);
			return rows.map((row) => ({
				folder: row.folder_id,
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
	for (const { folder, oid } of expired) await lfs.delete(folder, oid);
	return expired.length;
}
