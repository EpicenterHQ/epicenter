/**
 * Reading a folder's log (ADR-0824). Each answer is one statement, so one
 * consistent read: what changed since a cursor, the folder's files now or
 * at any change, a log of changes (one file's history among them), every
 * folder's head, every folder's title, and which bytes a folder holds.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '../db/create-db.js';
import type { BlobStore } from './blob-store.js';
import { type Cursor, readCursor, texts, writeCursor } from './versions.js';

type Runner = Pick<Db, 'execute'>;

/**
 * The most paths `changes` answers; past it, and past `CHANGES_GAP`
 * changes, it answers "compare every path" (null) instead.
 */
export const CHANGES_LIMIT = 2000;
/** The most changes `changes` reads past a cursor before answering "compare every path". */
export const CHANGES_GAP = 50_000;

/** A path's version after a change: null for a deletion. */
export type Changed = { path: string; version: string | null };

/**
 * Where the log of `folder` is now, and each path whose version changed
 * since `since` with its version now. `changes` is null ("compare every
 * path") when `since` is absent, names another epoch or a change this log
 * has not reached, or the gap passes `CHANGES_GAP` changes or `limit`
 * paths. Undefined when there is no such folder.
 */
export async function changesSince(
	db: Runner,
	folder: string,
	since: string | undefined,
	limit = CHANGES_LIMIT,
): Promise<{ cursor: Cursor; changes: Changed[] | null } | undefined> {
	const from = since === undefined ? null : readCursor(since);
	const { rows } = await db.execute<{
		epoch: string;
		seq: string;
		changes: Changed[] | null;
	}>(sql`
		with f as (select epoch, seq from folder where id = ${folder})
		select f.epoch, f.seq, (
			select json_agg(json_build_object('path', c.path, 'version', c.version))
			from (
				select distinct on (cf.path) cf.path, cf.version
				from change_file cf
				where cf.folder_id = ${folder}
					and f.epoch = ${from?.epoch ?? null}::text
					and cf.seq > ${from?.seq ?? 0}
					and f.seq >= ${from?.seq ?? 0}
					and f.seq - ${from?.seq ?? 0} <= ${CHANGES_GAP}
				order by cf.path, cf.seq desc
				limit ${limit + 1}
			) c
		) as changes
		from f
	`);
	const row = rows[0];
	if (row === undefined) return undefined;
	const cursor = { epoch: row.epoch, seq: Number(row.seq) };
	if (
		from === null ||
		from.epoch !== cursor.epoch ||
		from.seq > cursor.seq ||
		cursor.seq - from.seq > CHANGES_GAP
	)
		return { cursor, changes: null };
	const changes = row.changes ?? [];
	return { cursor, changes: changes.length > limit ? null : changes };
}

/** One file of a folder: its version and size, and its bytes when asked for and kept inline. */
export type ListedFile = {
	path: string;
	version: string;
	size: number;
	base64?: string;
};

/**
 * The files of `folder` as of `seq` (now, when absent): every one, or only
 * `paths`, sorted by path, with the cursor of the log's head and the seq
 * they are as of. With `bytes`, each file kept inline brings its bytes.
 */
export async function filesAt(
	db: Runner,
	folder: string,
	{
		seq,
		paths,
		bytes = false,
	}: { seq?: number; paths?: readonly string[]; bytes?: boolean } = {},
): Promise<{ cursor: Cursor; seq: number; files: ListedFile[] } | undefined> {
	const only =
		paths === undefined
			? sql`true`
			: sql`x.path collate "C" = any(${texts(paths)})`;
	const source =
		seq === undefined
			? sql`select path, version, size from file where folder_id = ${folder}`
			: sql`select * from (
					select distinct on (path) path, version, size from change_file
					where folder_id = ${folder} and seq <= ${seq}
					order by path, seq desc
				) d where d.version is not null`;
	const { rows } = await db.execute<{
		epoch: string;
		seq: string;
		files: ListedFile[] | null;
	}>(sql`
		select f.epoch, f.seq, (
			select json_agg(json_strip_nulls(json_build_object(
				'path', x.path, 'version', x.version, 'size', x.size,
				'base64', case when ${bytes} then encode(b.inline, 'base64') end
			)) order by x.path collate "C")
			from (${source}) x
			left join blob b on ${bytes} and b.folder_id = ${folder} and b.sha256 = x.version
			where ${only}
		) as files
		from folder f where f.id = ${folder}
	`);
	const row = rows[0];
	if (row === undefined) return undefined;
	const head = Number(row.seq);
	return {
		cursor: { epoch: row.epoch, seq: head },
		seq: seq === undefined ? head : Math.min(seq, head),
		files: (row.files ?? []).map((file) => ({
			...file,
			size: Number(file.size),
			...(file.base64 === undefined
				? {}
				: { base64: file.base64.replace(/\n/g, '') }),
		})),
	};
}

/** One change of the log, as read. */
export type LoggedChange = {
	seq: number;
	at: string;
	author: string;
	via: string;
	message: string | null;
	digest: string;
	files: { path: string; version: string | null; size: number | null }[];
	marks: string[];
};

/**
 * Changes of `folder`'s log, at most `limit`: after `after` oldest first,
 * else at or before `before` (the head when absent) newest first. With
 * `path`, only the changes that wrote it, each with that file alone: the
 * file's history.
 */
export async function readLog(
	db: Runner,
	folder: string,
	{
		after,
		before,
		path,
		limit = 50,
	}: { after?: number; before?: number; path?: string; limit?: number },
): Promise<LoggedChange[]> {
	const onPath =
		path === undefined ? sql`true` : sql`cf.path collate "C" = ${path}`;
	const which =
		path === undefined
			? sql`true`
			: sql`exists (select 1 from change_file p where p.folder_id = c.folder_id and p.seq = c.seq and p.path collate "C" = ${path})`;
	const range =
		after !== undefined
			? sql`c.seq > ${after} order by c.seq asc`
			: before !== undefined
				? sql`c.seq <= ${before} order by c.seq desc`
				: sql`true order by c.seq desc`;
	const { rows } = await db.execute<{
		seq: string;
		at: Date;
		author_text: string;
		via: string;
		message: string | null;
		digest: string;
		files: LoggedChange['files'] | null;
		marks: string[] | null;
	}>(sql`
		select c.seq, c.at, c.author_text, c.via, c.message, c.digest,
			(select json_agg(json_build_object('path', cf.path, 'version', cf.version, 'size', cf.size) order by cf.path collate "C")
			 from change_file cf where cf.folder_id = c.folder_id and cf.seq = c.seq and ${onPath}) as files,
			(select json_agg(m.name order by m.name) from mark m where m.folder_id = c.folder_id and m.seq = c.seq) as marks
		from change c
		where c.folder_id = ${folder} and ${which} and ${range}
		limit ${limit}
	`);
	return rows.map((row) => ({
		seq: Number(row.seq),
		at: new Date(row.at).toISOString(),
		author: row.author_text,
		via: row.via,
		message: row.message,
		digest: row.digest,
		files: (row.files ?? []).map((file) => ({
			...file,
			size: file.size === null ? null : Number(file.size),
		})),
		marks: row.marks ?? [],
	}));
}

/**
 * The change `folder` was at, at `time`: the last change made at or before
 * it, 0 before the first.
 */
export async function seqAtTime(
	db: Runner,
	folder: string,
	time: Date,
): Promise<number> {
	const { rows } = await db.execute<{ seq: string | null }>(sql`
		select max(seq) as seq from change
		where folder_id = ${folder} and at <= ${time.toISOString()}
	`);
	return Number(rows[0]?.seq ?? 0);
}

/**
 * The head of every folder `accountId` holds that `app` reaches (null:
 * every one), as a cursor: one statement a program polls instead of one
 * request per folder (ADR-0819).
 */
export async function folderHeads(
	db: Runner,
	{ accountId, app }: { accountId: string; app: string | null },
): Promise<Record<string, string>> {
	const { rows } = await db.execute<{ id: string; epoch: string; seq: string }>(
		sql`
			select f.id, f.epoch, f.seq
			from folder_member m
			join folder f on f.id = m.folder_id
			where m.account_id = ${accountId}
				and (${app}::text is null or exists (
					select 1 from folder_app a where a.folder_id = m.folder_id and a.app = ${app}
				))
		`,
	);
	return Object.fromEntries(
		rows.map(({ id, epoch, seq }) => [
			id,
			writeCursor({ epoch, seq: Number(seq) }),
		]),
	);
}

/** The largest `epicenter.json` a listing reads a title from. */
const MAX_CONTRACT_BYTES = 256 * 1024;

const titleOf = (bytes: Uint8Array): string | null => {
	try {
		const { title } = JSON.parse(new TextDecoder().decode(bytes)) as {
			title?: unknown;
		};
		return typeof title === 'string' && title.trim() !== '' ? title : null;
	} catch {
		return null;
	}
};

/**
 * Each folder's title (ADR-0811): the `title` of its `epicenter.json`, null
 * for a folder without one or without a string title. One statement reads
 * every contract kept inline; a contract too large for that is read from
 * the blob store.
 */
export async function folderTitles(
	db: Runner,
	store: BlobStore | null,
	folders: readonly string[],
): Promise<Map<string, string | null>> {
	const out = new Map<string, string | null>(
		folders.map((folder) => [folder, null]),
	);
	if (folders.length === 0) return out;
	const { rows } = await db.execute<{
		folder_id: string;
		version: string;
		size: string;
		inline: Buffer | null;
	}>(sql`
		select f.folder_id, f.version, f.size, b.inline
		from file f
		join blob b on b.folder_id = f.folder_id and b.sha256 = f.version
		where f.folder_id = any(${texts(folders)})
			and f.path = 'epicenter.json'
			and b.state <> 'purged'
	`);
	await Promise.all(
		rows.map(async (row) => {
			if (row.inline !== null) {
				out.set(row.folder_id, titleOf(new Uint8Array(row.inline)));
				return;
			}
			if (store === null || Number(row.size) > MAX_CONTRACT_BYTES) return;
			const found = await store.get(row.folder_id, row.version);
			if (found === null) return;
			out.set(
				row.folder_id,
				titleOf(new Uint8Array(await new Response(found.body).arrayBuffer())),
			);
		}),
	);
	return out;
}

/** What a folder holds of one version's bytes: inline, in the blob store (`size`), or none. */
export type HeldBlob = { base64: string } | { size: number } | null;

/** What `folder` holds of each of `versions`, in order. */
export async function blobsOf(
	db: Runner,
	folder: string,
	versions: readonly string[],
): Promise<HeldBlob[]> {
	if (versions.length === 0) return [];
	const { rows } = await db.execute<{
		sha256: string;
		size: string;
		state: string;
		inline: Buffer | null;
	}>(sql`
		select sha256, size, state, inline from blob
		where folder_id = ${folder} and sha256 = any(${texts(versions)})
	`);
	const held = new Map(rows.map((row) => [row.sha256, row]));
	return versions.map((version) => {
		const row = held.get(version);
		if (row === undefined || row.state === 'purged') return null;
		return row.inline !== null
			? { base64: Buffer.from(row.inline).toString('base64') }
			: { size: Number(row.size) };
	});
}

/** Which of `versions` `folder` holds no bytes for: what an upload must send. */
export async function missingVersions(
	db: Runner,
	folder: string,
	versions: readonly string[],
): Promise<string[]> {
	if (versions.length === 0) return [];
	const { rows } = await db.execute<{ sha256: string }>(sql`
		select sha256 from blob
		where folder_id = ${folder} and state <> 'purged'
			and sha256 = any(${texts(versions)})
	`);
	const held = new Set(rows.map(({ sha256 }) => sha256));
	return [...new Set(versions)].filter((version) => !held.has(version));
}
