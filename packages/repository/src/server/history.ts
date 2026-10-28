/**
 * Path history: what happened at each path, so a change made from an older
 * position finds its note. Identity is the path, so a change follows every
 * move made since its position, sees a delete, and tells a note that was
 * deleted and whose path another note then took from the note itself.
 *
 * Git is the history. Every commit names the path events it includes in
 * trailers, next to `Epicenter-Seq`; the server keeps only the events its
 * overlay holds, until the commit that includes them lands. A change made
 * from an older position is traced through the commits after it, then the
 * overlay, with no window: a device may return after any time offline.
 */
import type { SqlDriver } from '../sql.js';

export type PathEvent =
	/** `restore`: an edit brought back the deleted note at its own path. */
	| { kind: 'create' | 'restore' | 'delete'; path: string }
	| { kind: 'move'; path: string; dest: string }
	/**
	 * A change made before sequence `before` that addresses `path` means the
	 * note the server put at `dest`: a note displaced from `path` by a reuse.
	 */
	| { kind: 'relocate'; path: string; dest: string; before: number };

/** A path event and the sequence of the batch that made it. */
export type SequencedEvent = PathEvent & { seq: number };

export type Traced = {
	/** Where the note is now, or where it was when deleted. */
	path: string;
	deleted: boolean;
	/** After the delete another note took the path, so the path is not this note. */
	reused: boolean;
	/** The sequence of the delete, or null. */
	vacatedAt: number | null;
	/** The note was moved by a change the caller had not seen. */
	moved: boolean;
};

/**
 * Where the note a change made at `since` addressed as `path` is, after
 * `events` (in order). Events at or before `since` are ones the change saw.
 */
export function trace(path: string, since: number, events: SequencedEvent[]): Traced {
	let at = path;
	let deleted = false;
	let reused = false;
	let vacatedAt: number | null = null;
	let moved = false;
	for (const event of events) {
		if (event.seq <= since) continue;
		if (event.kind === 'relocate') {
			if (event.path === at && since < event.before) {
				at = event.dest;
				deleted = false;
				reused = false;
			}
			continue;
		}
		if (reused) continue;
		if (deleted) {
			if (event.kind === 'restore' && event.path === at) deleted = false;
			else if ((event.kind === 'create' && event.path === at) || (event.kind === 'move' && event.dest === at)) reused = true;
			continue;
		}
		if (event.kind === 'move' && event.path === at) {
			at = event.dest;
			moved = true;
		} else if (event.kind === 'delete' && event.path === at) {
			deleted = true;
			vacatedAt = event.seq;
		}
	}
	return { path: at, deleted, reused, vacatedAt, moved };
}

// ----------------------------------------------------------------------------
// Trailers
// ----------------------------------------------------------------------------

const quote = (text: string) => JSON.stringify(text);
const QUOTED = String.raw`"(?:[^"\\]|\\.)*"`;
const TRAILER = new RegExp(
	String.raw`^Epicenter-(Create|Restore|Delete|Move|Relocate): (${QUOTED})(?: -> (${QUOTED}))?(?:; before (\d+))?; seq (\d+)$`,
	'gm',
);

/**
 * The commit trailer that records one path event. Paths are JSON strings,
 * matching `Epicenter-Overlap`:
 *
 *     Epicenter-Move: "notes/a.md" -> "archive/a.md"; seq 7
 *     Epicenter-Relocate: "a.md" -> "a (bob, 2026-10-28).md"; before 3; seq 9
 */
export function pathEventTrailer(event: SequencedEvent): string {
	const name = `${event.kind.charAt(0).toUpperCase()}${event.kind.slice(1)}`;
	const dest = 'dest' in event ? ` -> ${quote(event.dest)}` : '';
	const before = event.kind === 'relocate' ? `; before ${event.before}` : '';
	return `Epicenter-${name}: ${quote(event.path)}${dest}${before}; seq ${event.seq}`;
}

/** The path events a commit message records, in order. */
export function pathEventsOf(message: string): SequencedEvent[] {
	const events: SequencedEvent[] = [];
	for (const [, name = '', path = '', dest, before, seq = ''] of message.matchAll(TRAILER)) {
		const from = JSON.parse(path) as string;
		const at = Number(seq);
		if (name === 'Relocate' && dest !== undefined && before !== undefined)
			events.push({ kind: 'relocate', path: from, dest: JSON.parse(dest) as string, before: Number(before), seq: at });
		else if (name === 'Move' && dest !== undefined) events.push({ kind: 'move', path: from, dest: JSON.parse(dest) as string, seq: at });
		else if (name === 'Create' || name === 'Restore' || name === 'Delete')
			events.push({ kind: name === 'Create' ? 'create' : name === 'Restore' ? 'restore' : 'delete', path: from, seq: at });
	}
	return events;
}

// ----------------------------------------------------------------------------
// The overlay's events
// ----------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, seq INTEGER NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL, dest TEXT, before INTEGER) STRICT;
`;

type Row = { seq: number; kind: PathEvent['kind']; path: string; dest: string | null; before: number | null };

function fromRow({ seq, kind, path, dest, before }: Row): SequencedEvent {
	if (kind === 'relocate') return { kind, path, dest: dest ?? '', before: before ?? 0, seq };
	if (kind === 'move') return { kind, path, dest: dest ?? '', seq };
	return { kind, path, seq };
}

/** The path events of the server's overlay, in `driver`. */
export function createPathHistory(driver: SqlDriver) {
	driver.exec(SCHEMA);
	const between = (after: number, through: number) =>
		driver
			.all<Row>('SELECT seq, kind, path, dest, before FROM history WHERE seq > ? AND seq <= ? ORDER BY seq, id', [after, through])
			.map(fromRow);

	return {
		/** The events after sequence `after` through `through`, in order. */
		between,

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

		/** Drop the events through `seq`: Git's commit trailers now hold them. */
		clearThrough(seq: number) {
			driver.run('DELETE FROM history WHERE seq <= ?', [seq]);
		},
	};
}
export type PathHistory = ReturnType<typeof createPathHistory>;
