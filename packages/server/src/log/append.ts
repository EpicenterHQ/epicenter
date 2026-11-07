/**
 * A change appended to a folder's log (ADR-0824): one call of
 * `epicenter_append_change` (`apps/api/drizzle/0011_history_log.sql`, named
 * in `0013_append_change.sql`), so one round trip. Each path
 * lands only where it still holds the version its writer expects; otherwise
 * nothing lands and the answer names every path that moved. A write either
 * brings its bytes (at most `INLINE_MAX`, kept inline) or names a version
 * the folder already holds, so a restore moves no bytes.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '../db/create-db.js';
import { type Cursor, foldPath, INLINE_MAX, sha256Hex } from './versions.js';

type Runner = Pick<Db, 'execute'>;

/** One path of a change, as a writer asks for it. */
export type ChangeWrite =
	/** Bytes that come with the change: at most `INLINE_MAX`. */
	| { path: string; expect: string | null; bytes: Uint8Array }
	/** A version the folder holds already: uploaded, or an older one restored. */
	| { path: string; expect: string | null; version: string }
	| { path: string; expect: string | null; delete: true };

/** Why a change refused a path: another name differing only in case, a folder there, or a file on the way. */
export type ChangeRefusal = {
	path: string;
	held: string;
	reason: 'case' | 'folder' | 'file';
};

export type AppendAnswer =
	/** Landed, or changed nothing: the log's head, and the version now at each path (null: none). */
	| {
			landed: true;
			cursor: Cursor;
			versions: Record<string, string | null>;
	  }
	| { moved: { path: string; now: string | null }[] }
	| { missing: string[] }
	| { refused: ChangeRefusal }
	| { error: 'no_folder' | 'not_importing' };

/** An imported commit's own author (`Name <email>`), time, and message (ADR-0826). */
export type Imported = { author: string; at: Date; message: string | null };

/**
 * Append one change of `files` to `folder` as `account`, through the
 * client `via`. With
 * `imported`, the change keeps that author, time, and message, which only
 * a folder still importing takes.
 */
export async function appendChange(
	db: Runner,
	{
		folder,
		account,
		via,
		files,
		imported,
	}: {
		folder: string;
		account: string | null;
		via: string;
		files: readonly ChangeWrite[];
		imported?: Imported;
	},
): Promise<AppendAnswer> {
	const asked = await Promise.all(
		files.map(async (file) => {
			const common = {
				path: file.path,
				folded: foldPath(file.path),
				expect: file.expect,
			};
			if ('delete' in file) return { ...common, version: null };
			if ('version' in file) return { ...common, version: file.version };
			if (file.bytes.byteLength > INLINE_MAX)
				throw new Error(
					`${file.path}: bytes over ${INLINE_MAX} are uploaded, then named`,
				);
			return {
				...common,
				version: await sha256Hex(file.bytes),
				size: file.bytes.byteLength,
				inline: Buffer.from(file.bytes).toString('base64'),
			};
		}),
	);
	const { rows } = await db.execute<{ answer: Record<string, unknown> }>(sql`
		select epicenter_append_change(
			${folder}, ${account}, ${via},
			${JSON.stringify(asked)}::jsonb,
			${
				imported === undefined
					? null
					: JSON.stringify({
							author: imported.author,
							at: imported.at.getTime(),
							message: imported.message,
						})
			}::jsonb
		) as answer
	`);
	const answer = rows[0]?.answer ?? {};
	if (typeof answer.seq === 'number' || typeof answer.seq === 'string')
		return {
			landed: true,
			cursor: { epoch: String(answer.epoch), seq: Number(answer.seq) },
			versions: answer.versions as Record<string, string | null>,
		};
	return answer as AppendAnswer;
}
