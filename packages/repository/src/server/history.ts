/**
 * Live history, kept in the `Store`: every commit on `main` in order (its
 * place), each with the tree it left, the texts those trees name, which
 * paths each commit deleted, `main`'s spelling and last author of each path,
 * and the counters the server keeps. Everything a fresh instance needs is
 * here, so a crash loses nothing that was answered.
 *
 * Trees are Git tree objects (core/tree), stored as nodes by id; a commit's
 * snapshot stays readable for as long as its row is kept. Texts and nodes
 * are kept only while a tree that names them is (`sweep`).
 */
import type { Author, CommitFile } from '../core/commit.js';
import { fold } from '../core/door.js';
import { gitBlobHash, type TreeEntry } from '../core/hash.js';
import type { LfsPointer } from '../core/markdown.js';
import { createTreeStore, type TreeNodes } from '../core/tree.js';
import { first, type SqlDriver } from '../sql.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS nodes (hash TEXT PRIMARY KEY, entries TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS commits (
	id TEXT PRIMARY KEY,
	place INTEGER UNIQUE,
	parents TEXT NOT NULL,
	user TEXT NOT NULL,
	device TEXT NOT NULL,
	time TEXT NOT NULL,
	at INTEGER NOT NULL,
	tree TEXT NOT NULL,
	blocks INTEGER NOT NULL,
	merged_into TEXT,
	message TEXT
);
CREATE TABLE IF NOT EXISTS deletes (path TEXT NOT NULL, place INTEGER NOT NULL, PRIMARY KEY (path, place));
CREATE INDEX IF NOT EXISTS deletes_by_place ON deletes (place);
CREATE TABLE IF NOT EXISTS spellings (folded TEXT PRIMARY KEY, path TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS authors (path TEXT PRIMARY KEY, user TEXT NOT NULL, device TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outcomes (id TEXT PRIMARY KEY, at INTEGER NOT NULL, place INTEGER NOT NULL, answer TEXT NOT NULL, paths TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, at INTEGER NOT NULL, paths TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS buckets (user TEXT PRIMARY KEY, tokens REAL NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS uploads (oid TEXT PRIMARY KEY, size INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS flushes (n INTEGER PRIMARY KEY, oid TEXT NOT NULL, tree TEXT NOT NULL, through INTEGER NOT NULL, message TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS journal (n INTEGER PRIMARY KEY, state TEXT NOT NULL, plan TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS received (next TEXT PRIMARY KEY, merged INTEGER NOT NULL, at INTEGER NOT NULL);
`;

/** One commit as history keeps it. `place` is its index on `main`, null for a device's commit a merge took in. */
export type Stored = {
	id: string;
	place: number | null;
	parents: string[];
	author: Author;
	time: string;
	at: number;
	tree: string;
	/** A merge that wrote a conflict block: a Git commit of its own at the next flush. */
	blocks: boolean;
	/** Its writer's message (a merge carries the message of the commit it takes in): a Git commit of its own at the next flush, with this as its message. */
	message?: string;
};

type Row = { id: string; place: number | null; parents: string; user: string; device: string; time: string; at: number; tree: string; blocks: number; message: string | null };

const fromRow = (row: Row): Stored => ({
	id: row.id,
	place: row.place,
	parents: JSON.parse(row.parents) as string[],
	author: { user: row.user, device: row.device },
	time: row.time,
	at: row.at,
	tree: row.tree,
	blocks: row.blocks === 1,
	...(row.message === null ? {} : { message: row.message }),
});

/** Whether the server holds a pointer's bytes, at its size: a pointer is admitted only then. */
export const holdsBlob = (store: SqlDriver, { oid, size }: LfsPointer) => first(store, 'SELECT 1 FROM uploads WHERE oid = ? AND size = ?', [oid, size]) !== undefined;

export function openHistory(store: SqlDriver) {
	// Presence before sizes were recorded (phase 8) admits nothing at a size, so it starts again.
	if (store.all<{ name: string }>('PRAGMA table_info(uploads)').some((column) => column.name === 'oid') && !store.all<{ name: string }>('PRAGMA table_info(uploads)').some((column) => column.name === 'size')) store.exec('DROP TABLE uploads');
	store.exec(SCHEMA);
	// A store made before commits carried a message gets the column.
	if (!store.all<{ name: string }>('PRAGMA table_info(commits)').some((column) => column.name === 'message')) store.exec('ALTER TABLE commits ADD COLUMN message TEXT');

	// Tree nodes: cached once read or written, stored once.
	const cache = new Map<string, Map<string, TreeEntry>>();
	const nodes: TreeNodes = {
		get(hash) {
			const cached = cache.get(hash);
			if (cached !== undefined) return cached;
			const row = first<{ entries: string }>(store, 'SELECT entries FROM nodes WHERE hash = ?', [hash]);
			if (row === undefined) return undefined;
			const entries = new Map(JSON.parse(row.entries) as [string, TreeEntry][]);
			cache.set(hash, entries);
			return entries;
		},
		set(hash, entries) {
			if (cache.has(hash)) return;
			cache.set(hash, entries);
			store.run('INSERT OR IGNORE INTO nodes (hash, entries) VALUES (?, ?)', [hash, JSON.stringify([...entries])]);
		},
	};
	const trees = createTreeStore(nodes);

	const meta = {
		get: (key: string) => first<{ value: string }>(store, 'SELECT value FROM meta WHERE key = ?', [key])?.value ?? null,
		set: (key: string, value: string | number) => store.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, String(value)]),
		number: (key: string) => Number(meta.get(key) ?? 0),
	};

	const blob = (hash: string) => first<{ text: string }>(store, 'SELECT text FROM blobs WHERE hash = ?', [hash])?.text ?? null;
	const keep = (text: string) => {
		const hash = gitBlobHash(text);
		store.run('INSERT OR IGNORE INTO blobs (hash, text) VALUES (?, ?)', [hash, text]);
		return hash;
	};

	const commit = (id: string) => {
		const row = first<Row>(store, 'SELECT * FROM commits WHERE id = ?', [id]);
		return row === undefined ? null : fromRow(row);
	};
	const at = (place: number) => {
		const row = first<Row>(store, 'SELECT * FROM commits WHERE place = ?', [place]);
		if (row === undefined) throw new Error(`no commit at place ${place}`);
		return fromRow(row);
	};
	const top = () => meta.number('top');
	const insert = (stored: Stored, mergedInto: string | null = null) =>
		store.run('INSERT OR REPLACE INTO commits (id, place, parents, user, device, time, at, tree, blocks, merged_into, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
			stored.id,
			stored.place,
			JSON.stringify(stored.parents),
			stored.author.user,
			stored.author.device,
			stored.time,
			stored.at,
			stored.tree,
			stored.blocks ? 1 : 0,
			mergedInto,
			stored.message ?? null,
		]);

	const textIn = (tree: string, path: string) => {
		const hash = trees.read(tree, path);
		return hash === null ? null : blob(hash);
	};

	return {
		trees,
		meta,
		/** A text by its hash, or null. */
		blob,
		/** Keep a text; its hash. */
		keep,
		commit,
		at,
		top,
		/** The oldest place still kept. */
		offset: () => meta.number('offset'),
		main: () => at(top()),
		/** A commit's place on `main`, or undefined when it is not on `main` or was pruned. */
		placeOf: (id: string) => first<{ place: number | null }>(store, 'SELECT place FROM commits WHERE id = ?', [id])?.place ?? undefined,
		/**
		 * What a commit on `id` is merged against: its tree, and the place on
		 * `main` after which changes are its writer's news (its own place, or
		 * for a commit a merge took in, that merge's place). Undefined when
		 * history no longer keeps it.
		 */
		baseOf(id: string): { from: number; tree: string } | undefined {
			const row = first<{ place: number | null; tree: string; merged_into: string | null }>(store, 'SELECT place, tree, merged_into FROM commits WHERE id = ?', [id]);
			if (row === undefined) return undefined;
			if (row.place !== null) return { from: row.place, tree: row.tree };
			const into = row.merged_into === null ? undefined : first<{ place: number | null }>(store, 'SELECT place FROM commits WHERE id = ?', [row.merged_into])?.place;
			return into === undefined || into === null ? undefined : { from: into, tree: row.tree };
		},
		textIn,
		/** Was `path` deleted on `main` after place `from`? */
		deletedSince: (from: number, path: string) => first(store, 'SELECT 1 FROM deletes WHERE path = ? AND place > ? LIMIT 1', [path, from]) !== undefined,
		/** The ids on `main` after place `from`, through place `to`. */
		idsAfter: (from: number, to = top()) =>
			store.all<{ id: string }>('SELECT id FROM commits WHERE place > ? AND place <= ? ORDER BY place', [from, to]).map((row) => row.id),
		/** `main`'s spelling of a path, by its folded identity. */
		spelling: (path: string) => first<{ path: string }>(store, 'SELECT path FROM spellings WHERE folded = ?', [fold(path)])?.path ?? null,
		lastAuthor: (path: string): Author | null => {
			const row = first<{ user: string; device: string }>(store, 'SELECT user, device FROM authors WHERE path = ?', [path]);
			return row === undefined ? null : { user: row.user, device: row.device };
		},
		/** Start history with a root commit whose tree is `tree`. */
		root(stored: Omit<Stored, 'place'>) {
			insert({ ...stored, place: 0 });
			meta.set('top', 0);
			meta.set('offset', 0);
			for (const path of trees.diff(trees.empty, stored.tree)) store.run('INSERT OR REPLACE INTO spellings (folded, path) VALUES (?, ?)', [fold(path), path]);
		},
		/**
		 * Put a commit on `main`: its tree, the paths it changed and deleted,
		 * `main`'s spellings and last authors. The paths it changed, with the
		 * text before and after each.
		 */
		advance(stored: Omit<Stored, 'place' | 'tree'>, files: CommitFile[]) {
			const before = at(top());
			const tree = trees.update(
				before.tree,
				files.map((f) => [f.path.split('/'), f.text === null ? null : keep(f.text)]),
			);
			const changed = files
				.map((f) => ({ path: f.path, before: textIn(before.tree, f.path), after: f.text }))
				.filter((f) => f.before !== f.after);
			const place = top() + 1;
			insert({ ...stored, place, tree });
			meta.set('top', place);
			meta.set('made', meta.number('made') + 1);
			for (const { path, after } of changed) {
				if (after === null) {
					store.run('INSERT OR IGNORE INTO deletes (path, place) VALUES (?, ?)', [path, place]);
					store.run('DELETE FROM spellings WHERE folded = ?', [fold(path)]);
				} else store.run('INSERT OR REPLACE INTO spellings (folded, path) VALUES (?, ?)', [fold(path), path]);
				store.run('INSERT OR REPLACE INTO authors (path, user, device) VALUES (?, ?, ?)', [path, stored.author.user, stored.author.device]);
			}
			return { tree, changed };
		},
		/** Keep a device's commit that a merge takes in as its second parent. */
		keepSide(stored: Omit<Stored, 'place'>, mergedInto: string, files: CommitFile[]) {
			for (const f of files) if (f.text !== null) keep(f.text);
			insert({ ...stored, place: null }, mergedInto);
		},
		/** Drop places before `keep` (never `main` itself), with the device commits their merges took in. */
		pruneBefore(keep: number) {
			const offset = meta.number('offset');
			if (keep <= offset) return;
			store.run('DELETE FROM commits WHERE merged_into IN (SELECT id FROM commits WHERE place < ?)', [keep]);
			store.run('DELETE FROM commits WHERE place < ?', [keep]);
			store.run('DELETE FROM deletes WHERE place < ?', [keep]);
			meta.set('offset', keep);
		},
		/**
		 * Delete every text and tree node that no tree named by a kept commit
		 * (on `main` or merged in) or by `roots` reaches. Mark and sweep: what
		 * a kept tree reaches is walked once, shared subtrees included.
		 */
		sweep(roots: string[]) {
			const reached = new Set<string>();
			const texts = new Set<string>();
			const walk = (tree: string) => {
				if (reached.has(tree)) return;
				reached.add(tree);
				for (const entry of nodes.get(tree)?.values() ?? []) {
					if (entry.kind === 'tree') walk(entry.hash);
					else texts.add(entry.hash);
				}
			};
			walk(trees.empty);
			for (const { tree } of store.all<{ tree: string }>('SELECT DISTINCT tree FROM commits')) walk(tree);
			for (const tree of roots) walk(tree);
			for (const { hash } of store.all<{ hash: string }>('SELECT hash FROM nodes'))
				if (!reached.has(hash)) {
					store.run('DELETE FROM nodes WHERE hash = ?', [hash]);
					cache.delete(hash);
				}
			for (const { hash } of store.all<{ hash: string }>('SELECT hash FROM blobs')) if (!texts.has(hash)) store.run('DELETE FROM blobs WHERE hash = ?', [hash]);
		},
		/** The newest place whose commit is older than `cutoff`, or -1. */
		newestBefore: (cutoff: number) => first<{ place: number | null }>(store, 'SELECT MAX(place) AS place FROM commits WHERE place IS NOT NULL AND at < ?', [cutoff])?.place ?? -1,
	};
}
export type History = ReturnType<typeof openHistory>;
