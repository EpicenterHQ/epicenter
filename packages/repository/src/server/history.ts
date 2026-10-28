/**
 * Path history: what happened at each path, so a change made from an older
 * position finds its note. Identity is the path, so a change follows every
 * move made since its position, sees a delete, and tells a note that was
 * deleted and whose path another note then took from the note itself.
 *
 * The history covers the server's window only: rows older than it are pruned,
 * and a change made before the newest pruned sequence (the horizon) cannot be
 * fully traced. Everything that depends on that window is here (`covers`,
 * `horizon`, `prune`), so replacing it with a permanent log of moves and
 * deletes changes this module and nothing that calls `trace`.
 */
import { first, type SqlDriver } from '../sql.js';

export type PathEvent =
	/** `restore`: an edit brought back the deleted note at its own path. */
	| { kind: 'create' | 'restore' | 'delete'; path: string }
	| { kind: 'move'; path: string; dest: string }
	/**
	 * A change made before sequence `before` that addresses `path` means the
	 * note the server put at `dest`: a note displaced from `path` by a reuse,
	 * a taken destination, or an identity the window could not establish.
	 */
	| { kind: 'relocate'; path: string; dest: string; before: number };

export type Traced = {
	/** Where the note is now, or where it was when deleted. */
	path: string;
	deleted: boolean;
	/** After the delete another note took the path, so the path is not this note. */
	reused: boolean;
	/** The sequence of the delete, or null. */
	vacatedAt: number | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, seq INTEGER NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL, dest TEXT, before INTEGER) STRICT;
INSERT OR IGNORE INTO state VALUES ('horizon', 0);
`;

type Row = { seq: number; kind: PathEvent['kind']; path: string; dest: string | null; before: number | null };

/** Path history in `driver`, whose `state` table already exists. */
export function createPathHistory(driver: SqlDriver) {
	driver.exec(SCHEMA);
	const horizon = () =>
		first<{ value: number }>(driver, "SELECT value FROM state WHERE key = 'horizon'")?.value ?? 0;

	return {
		/** The newest sequence whose history was pruned. */
		horizon,
		/** Whether a change made at `since` can be traced: none of its history was pruned. */
		covers: (since: number) => since >= horizon(),

		/**
		 * Where the note a change made at `since` addressed as `path` is now.
		 * `pending` holds the relocations of the batch being applied, which a
		 * later change in the same batch must also follow.
		 */
		trace(path: string, since: number, pending: PathEvent[] = []): Traced {
			const rows = driver.all<Row>('SELECT seq, kind, path, dest, before FROM history WHERE seq > ? ORDER BY seq, id', [since]);
			let at = path;
			let deleted = false;
			let reused = false;
			let vacatedAt: number | null = null;
			const events: Row[] = [
				...rows,
				...pending.map((event) => ({ seq: Number.POSITIVE_INFINITY, dest: null, before: null, ...event })),
			];
			for (const row of events) {
				if (row.kind === 'relocate') {
					if (row.path === at && row.dest !== null && since < (row.before ?? 0)) {
						at = row.dest;
						deleted = false;
						reused = false;
					}
					continue;
				}
				if (reused) continue;
				if (deleted) {
					if (row.kind === 'restore' && row.path === at) deleted = false;
					else if ((row.kind === 'create' && row.path === at) || (row.kind === 'move' && row.dest === at)) reused = true;
					continue;
				}
				if (row.kind === 'move' && row.path === at && row.dest !== null) at = row.dest;
				else if (row.kind === 'delete' && row.path === at) {
					deleted = true;
					vacatedAt = row.seq;
				}
			}
			return { path: at, deleted, reused, vacatedAt };
		},

		/** The sequence at which the note now at `path` arrived there, if the history holds it. */
		arrivedAt(path: string): number | null {
			return (
				first<{ seq: number }>(
					driver,
					"SELECT seq FROM history WHERE (kind IN ('create', 'restore') AND path = ?) OR (kind IN ('move', 'relocate') AND dest = ?) ORDER BY seq DESC, id DESC LIMIT 1",
					[path, path],
				)?.seq ?? null
			);
		},

		record(seq: number, events: PathEvent[]) {
			for (const event of events)
				driver.run('INSERT INTO history (seq, kind, path, dest, before) VALUES (?, ?, ?, ?, ?)', [
					seq,
					event.kind,
					event.path,
					'dest' in event ? event.dest : null,
					'before' in event ? event.before : null,
				]);
		},

		/** Drop the history through `seq`, which becomes the horizon. */
		prune(seq: number) {
			driver.run('DELETE FROM history WHERE seq <= ?', [seq]);
			if (seq > horizon()) driver.run("UPDATE state SET value = ? WHERE key = 'horizon'", [seq]);
		},
	};
}
export type PathHistory = ReturnType<typeof createPathHistory>;
