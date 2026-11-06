/**
 * Marks (ADR-0826): a name a person gives one change of a folder's log,
 * with `epicenter mark <name>`. `history`, `log`, and `at` reach a change
 * by its mark, the export writes each mark as a Git tag, and an import
 * reads a repository's tags into marks.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '../db/create-db.js';

type Runner = Pick<Db, 'execute'>;

export type Mark = { name: string; seq: number; at: string };

/** Every mark of `folder`, by name. */
export async function listMarks(db: Runner, folder: string): Promise<Mark[]> {
	const { rows } = await db.execute<{ name: string; seq: string; at: Date }>(
		sql`select name, seq, at from mark where folder_id = ${folder} order by name`,
	);
	return rows.map((row) => ({
		name: row.name,
		seq: Number(row.seq),
		at: new Date(row.at).toISOString(),
	}));
}

/** The change `name` marks in `folder`, or null. */
export async function seqOfMark(
	db: Runner,
	folder: string,
	name: string,
): Promise<number | null> {
	const { rows } = await db.execute<{ seq: string }>(
		sql`select seq from mark where folder_id = ${folder} and name = ${name}`,
	);
	return rows[0] === undefined ? null : Number(rows[0].seq);
}

/**
 * Mark change `seq` of `folder` (its last change when absent) as `name`.
 * A name that marks another change is `taken`, unless `move` moves it;
 * a folder with no change yet has nothing to mark (`empty`).
 */
export async function setMark(
	db: Runner,
	{
		folder,
		name,
		account,
		seq,
		move = false,
	}: {
		folder: string;
		name: string;
		account: string | null;
		seq?: number;
		move?: boolean;
	},
): Promise<
	{ marked: Mark } | { taken: Mark } | { empty: true } | { unknown: number }
> {
	const { rows } = await db.execute<{
		head: string;
		target: string | null;
		name: string | null;
		seq: string | null;
		at: Date | null;
	}>(sql`
		with f as (select seq as head from folder where id = ${folder}),
		target as (
			select c.seq from change c, f
			where c.folder_id = ${folder} and c.seq = coalesce(${seq ?? null}::bigint, f.head)
		),
		written as (
			insert into mark (folder_id, name, seq, account_id)
			select ${folder}, ${name}, target.seq, ${account} from target
			on conflict (folder_id, name) do update
				set seq = excluded.seq, account_id = excluded.account_id, at = now()
				where ${move} or mark.seq = excluded.seq
			returning name, seq, at
		)
		select f.head, (select seq from target) as target, w.name, w.seq, w.at
		from f left join written w on true
	`);
	const row = rows[0];
	if (row === undefined) return { unknown: seq ?? 0 };
	if (row.target === null)
		return Number(row.head) === 0 && seq === undefined
			? { empty: true }
			: { unknown: seq ?? Number(row.head) };
	if (row.name !== null && row.seq !== null && row.at !== null)
		return {
			marked: {
				name: row.name,
				seq: Number(row.seq),
				at: new Date(row.at).toISOString(),
			},
		};
	const { rows: held } = await db.execute<{ seq: string; at: Date }>(
		sql`select seq, at from mark where folder_id = ${folder} and name = ${name}`,
	);
	const taken = held[0];
	return {
		taken: {
			name,
			seq: Number(taken?.seq ?? 0),
			at: new Date(taken?.at ?? 0).toISOString(),
		},
	};
}
