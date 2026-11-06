/**
 * A folder's bytes (ADR-0824, amending ADR-0809's ledger and purge): one
 * `blob` row per SHA-256 a folder holds. An upload a change has not named
 * yet is `pending`; the change that names it makes it `kept`;
 * `sweepPendingBlobs` deletes what stayed pending past a day, row and
 * bytes, with no walk over history. `purgeBlobs` deletes kept bytes and
 * leaves every row that names them, so the history still says which
 * version each path held, and its size.
 *
 * Retention (ADR-0824): any version may be purged, but by default only
 * one no file holds now and none held within `KEEP_MERGE_BASES_MS`, so a
 * computer offline that long still finds the version it last agreed on and
 * merges against it. Nothing thins history on its own yet.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '../db/create-db.js';
import type { BlobStore } from './blob-store.js';
import { INLINE_MAX, sha256Hex, texts, VERSION } from './versions.js';

type Runner = Pick<Db, 'execute'>;

/** How long an upload no change names stays before the sweep deletes it. */
export const PENDING_FOR_MS = 24 * 60 * 60 * 1000;

/**
 * How long a version stays after the last file holding it moved on: an
 * offline computer merges a note against the version it last agreed on, so
 * a purge leaves the versions of the last 90 days.
 */
export const KEEP_MERGE_BASES_MS = 90 * 24 * 60 * 60 * 1000;

export type PutBlobAnswer =
	| { status: 200 | 201; size: number }
	| { status: 413 | 422; error: string; message: string }
	| { status: 503; error: 'unavailable'; message: string };

/** The bytes of `body`, read whole when they are at most `max`: null past it, with what was read and the rest. */
async function readUpTo(
	body: ReadableStream<Uint8Array>,
	max: number,
): Promise<
	| { whole: Uint8Array }
	| { head: Uint8Array[]; rest: ReadableStreamDefaultReader<Uint8Array> }
> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return { whole: Buffer.concat(chunks) };
		chunks.push(value);
		length += value.length;
		if (length > max) return { head: chunks, rest: reader };
	}
}

/**
 * Store `body` as `sha256` for `folder`, refusing bytes that are not
 * `sha256`: idempotent, so a lost reply is sent again. Bytes up to
 * `INLINE_MAX` are kept in the row; larger ones go to `store`. Bytes the
 * folder did not hold are pending until a change names them; bytes it held
 * once and purged are kept again, since history names them.
 */
export async function putBlob({
	db,
	store,
	folder,
	sha256,
	body,
	length,
}: {
	db: Runner;
	store: BlobStore | null;
	folder: string;
	sha256: string;
	body: ReadableStream<Uint8Array>;
	/** The declared length (`content-length`), when there is one. */
	length?: number;
}): Promise<PutBlobAnswer> {
	if (!VERSION.test(sha256))
		return { status: 422, error: 'invalid_request', message: 'not a sha256' };
	const { rows } = await db.execute<{ size: string; state: string }>(sql`
		select size, state from blob where folder_id = ${folder} and sha256 = ${sha256}
	`);
	const held = rows[0];
	if (held !== undefined && held.state !== 'purged') {
		await body.cancel();
		// An upload the sweep might take soon is pending for a day again.
		await db.execute(sql`
			update blob set uploaded_at = now()
			where folder_id = ${folder} and sha256 = ${sha256} and state = 'pending'
		`);
		return { status: 200, size: Number(held.size) };
	}
	const record = (size: number, inline: Uint8Array | null) =>
		db.execute(sql`
			insert into blob (folder_id, sha256, size, state, inline)
			values (${folder}, ${sha256}, ${size}, 'pending', ${inline === null ? null : Buffer.from(inline)})
			on conflict (folder_id, sha256) do update set
				state = case when blob.state = 'purged' then 'kept' else blob.state end,
				inline = coalesce(blob.inline, excluded.inline),
				uploaded_at = now()
		`);
	const mismatch = (reason: 'hash-mismatch' | 'size-mismatch') =>
		({
			status: 422,
			error: reason,
			message:
				reason === 'hash-mismatch'
					? `the bytes' sha256 is not ${sha256}`
					: 'the bytes are not the declared length',
		}) as const;
	const read =
		length !== undefined && length > INLINE_MAX
			? null
			: await readUpTo(body, INLINE_MAX);
	if (read !== null && 'whole' in read) {
		if (length !== undefined && read.whole.byteLength !== length)
			return mismatch('size-mismatch');
		if ((await sha256Hex(read.whole)) !== sha256)
			return mismatch('hash-mismatch');
		await record(read.whole.byteLength, read.whole);
		return { status: 201, size: read.whole.byteLength };
	}
	if (store === null) {
		if (read !== null) await read.rest.cancel();
		else await body.cancel();
		return {
			status: 503,
			error: 'unavailable',
			message: `This server keeps no bytes over ${INLINE_MAX}.`,
		};
	}
	const stream =
		read === null
			? body
			: new ReadableStream<Uint8Array>({
					start(controller) {
						for (const chunk of read.head) controller.enqueue(chunk);
					},
					async pull(controller) {
						const { done, value } = await read.rest.read();
						if (done) controller.close();
						else controller.enqueue(value);
					},
					cancel: () => read.rest.cancel(),
				});
	const stored = await store.put(folder, sha256, stream, length);
	if (!stored.ok)
		return stored.reason === 'too-large'
			? { status: 413, error: 'too_large', message: 'the bytes are too large' }
			: mismatch(stored.reason);
	await record(stored.size, null);
	return { status: 201, size: stored.size };
}

/**
 * Delete every upload still pending `pendingForMs` before `now`: its row,
 * then its bytes. A change that names it meanwhile finds no row and is
 * told to upload it again. Answers how many.
 */
export async function sweepPendingBlobs({
	db,
	store,
	now = new Date(),
	pendingForMs = PENDING_FOR_MS,
}: {
	db: Runner;
	store: BlobStore | null;
	now?: Date;
	pendingForMs?: number;
}): Promise<number> {
	const { rows } = await db.execute<{
		folder_id: string;
		sha256: string;
		stored: boolean;
	}>(sql`
		delete from blob
		where state = 'pending'
			and uploaded_at < ${new Date(now.getTime() - pendingForMs).toISOString()}
		returning folder_id, sha256, inline is null as stored
	`);
	for (const row of rows)
		if (row.stored) await store?.delete(row.folder_id, row.sha256);
	return rows.length;
}

/** Why a version was not purged. */
export type PurgeRefusal = {
	version: string;
	reason: 'current' | 'recent' | 'unknown';
};

/**
 * Purge `versions` of `folder`: their bytes go, and every row naming them
 * stays. A version a file holds now (`current`), one a file held within
 * `keepForMs` before `now` (`recent`), or one the folder never held
 * (`unknown`) is refused, unless `force` purges any it holds.
 */
export async function purgeBlobs({
	db,
	store,
	folder,
	versions,
	now = new Date(),
	keepForMs = KEEP_MERGE_BASES_MS,
	force = false,
}: {
	db: Runner;
	store: BlobStore | null;
	folder: string;
	versions: readonly string[];
	now?: Date;
	keepForMs?: number;
	force?: boolean;
}): Promise<{ purged: string[]; refused: PurgeRefusal[] }> {
	if (versions.length === 0) return { purged: [], refused: [] };
	const { rows } = await db.execute<{
		sha256: string;
		current: boolean;
		until: Date | null;
	}>(sql`
		select b.sha256,
			exists (
				select 1 from file f where f.folder_id = b.folder_id and f.version = b.sha256
			) as current,
			(
				select max(c.at)
				from change_file cf
				join lateral (
					select min(n.seq) as seq from change_file n
					where n.folder_id = cf.folder_id and n.path = cf.path and n.seq > cf.seq
				) next on true
				join change c on c.folder_id = cf.folder_id and c.seq = next.seq
				where cf.folder_id = b.folder_id and cf.version = b.sha256
			) as until
		from blob b
		where b.folder_id = ${folder} and b.state <> 'purged'
			and b.sha256 = any(${texts(versions)})
	`);
	const held = new Map(rows.map((row) => [row.sha256, row]));
	const allowed: string[] = [];
	const refused: PurgeRefusal[] = [];
	const cutoff = now.getTime() - keepForMs;
	for (const version of new Set(versions)) {
		const row = held.get(version);
		if (row === undefined) refused.push({ version, reason: 'unknown' });
		else if (!force && row.current)
			refused.push({ version, reason: 'current' });
		else if (
			!force &&
			row.until !== null &&
			new Date(row.until).getTime() > cutoff
		)
			refused.push({ version, reason: 'recent' });
		else allowed.push(version);
	}
	if (allowed.length === 0) return { purged: [], refused };
	const purged = await db.execute<{ sha256: string; stored: boolean }>(sql`
		update blob set state = 'purged', inline = null
		where folder_id = ${folder} and sha256 = any(${texts(allowed)})
		returning sha256, size > ${INLINE_MAX} as stored
	`);
	for (const row of purged.rows)
		if (row.stored) await store?.delete(folder, row.sha256);
	return { purged: purged.rows.map(({ sha256 }) => sha256), refused };
}
