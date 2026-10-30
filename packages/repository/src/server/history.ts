/**
 * Live history, kept in the `Store`: every commit on `main` in order (its
 * place), each with the tree it left, the texts those trees name, `main`'s
 * spelling and last author of each path, each writer's last push, and the
 * counters the server keeps. Everything a fresh instance needs is here, so
 * a crash loses nothing that was answered.
 *
 * Trees are Git tree objects (core/tree), stored as nodes by id; a commit's
 * snapshot stays readable for as long as its row is kept, and nodes only
 * while a tree that names them is (`sweep`). RULE: a text stays until Git
 * has it, whatever names it: any version a writer saw may be the base of
 * its write, and once Git has it, it is read from Git.
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
	blocks INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS spellings (folded TEXT PRIMARY KEY, path TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS authors (path TEXT PRIMARY KEY, user TEXT NOT NULL, device TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS writers (user TEXT NOT NULL, device TEXT NOT NULL, epoch TEXT NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL, answer TEXT NOT NULL, PRIMARY KEY (user, device, epoch));
CREATE TABLE IF NOT EXISTS buckets (user TEXT PRIMARY KEY, tokens REAL NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS uploads (oid TEXT PRIMARY KEY, size INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS flushes (n INTEGER PRIMARY KEY, oid TEXT NOT NULL, tree TEXT NOT NULL, through INTEGER NOT NULL, message TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS journal (n INTEGER PRIMARY KEY, state TEXT NOT NULL, plan TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS received (next TEXT PRIMARY KEY, merged INTEGER NOT NULL, at INTEGER NOT NULL, siblings TEXT);
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
};

type Row = {
	id: string;
	place: number | null;
	parents: string;
	user: string;
	device: string;
	time: string;
	at: number;
	tree: string;
	blocks: number;
};

const fromRow = (row: Row): Stored => ({
	id: row.id,
	place: row.place,
	parents: JSON.parse(row.parents) as string[],
	author: { user: row.user, device: row.device },
	time: row.time,
	at: row.at,
	tree: row.tree,
	blocks: row.blocks === 1,
});

/** Whether the server holds a pointer's bytes, at its size: a pointer is admitted only then. */
export const holdsBlob = (store: SqlDriver, { oid, size }: LfsPointer) =>
	first(store, 'SELECT 1 FROM uploads WHERE oid = ? AND size = ?', [
		oid,
		size,
	]) !== undefined;

export function openHistory(store: SqlDriver) {
	// Presence before sizes were recorded (phase 8) admits nothing at a size, so it starts again.
	if (
		store
			.all<{ name: string }>('PRAGMA table_info(uploads)')
			.some((column) => column.name === 'oid') &&
		!store
			.all<{ name: string }>('PRAGMA table_info(uploads)')
			.some((column) => column.name === 'size')
	)
		store.exec('DROP TABLE uploads');
	// Answers kept by commit id for a window, ids recognized for a day, and deletes per place (before each write carried its base): a writer's last push answers a resend now, and a base is read by its hash.
	for (const table of ['outcomes', 'seen', 'deletes'])
		store.exec(`DROP TABLE IF EXISTS ${table}`);
	store.exec(SCHEMA);
	// A device's commit a merge took in as its second parent (before each write carried its base) is nothing a write or a catch-up reads.
	store.run('DELETE FROM commits WHERE place IS NULL');
	// Whether Git has a text (once a flush or a push put it there): only then may it go from the store.
	if (
		!store
			.all<{ name: string }>('PRAGMA table_info(blobs)')
			.some((column) => column.name === 'git')
	)
		store.exec('ALTER TABLE blobs ADD COLUMN git INTEGER NOT NULL DEFAULT 0');
	// Where a pushed blob that lost landed (phase 9g), so a retry's answer names it too.
	if (
		!store
			.all<{ name: string }>('PRAGMA table_info(received)')
			.some((column) => column.name === 'siblings')
	)
		store.exec('ALTER TABLE received ADD COLUMN siblings TEXT');

	// Tree nodes: cached once read or written, stored once.
	const cache = new Map<string, Map<string, TreeEntry>>();
	const nodes: TreeNodes = {
		get(hash) {
			const cached = cache.get(hash);
			if (cached !== undefined) return cached;
			const row = first<{ entries: string }>(
				store,
				'SELECT entries FROM nodes WHERE hash = ?',
				[hash],
			);
			if (row === undefined) return undefined;
			const entries = new Map(JSON.parse(row.entries) as [string, TreeEntry][]);
			cache.set(hash, entries);
			return entries;
		},
		set(hash, entries) {
			if (cache.has(hash)) return;
			cache.set(hash, entries);
			store.run('INSERT OR IGNORE INTO nodes (hash, entries) VALUES (?, ?)', [
				hash,
				JSON.stringify([...entries]),
			]);
		},
	};
	const trees = createTreeStore(nodes);

	const meta = {
		get: (key: string) =>
			first<{ value: string }>(store, 'SELECT value FROM meta WHERE key = ?', [
				key,
			])?.value ?? null,
		set: (key: string, value: string | number) =>
			store.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
				key,
				String(value),
			]),
		number: (key: string) => Number(meta.get(key) ?? 0),
	};

	const blob = (hash: string) =>
		first<{ text: string }>(store, 'SELECT text FROM blobs WHERE hash = ?', [
			hash,
		])?.text ?? null;
	const keep = (text: string, git = false) => {
		const hash = gitBlobHash(text);
		store.run(
			'INSERT INTO blobs (hash, text, git) VALUES (?, ?, ?) ON CONFLICT (hash) DO UPDATE SET git = MAX(git, excluded.git)',
			[hash, text, git ? 1 : 0],
		);
		return hash;
	};

	const commit = (id: string) => {
		const row = first<Row>(store, 'SELECT * FROM commits WHERE id = ?', [id]);
		return row === undefined ? null : fromRow(row);
	};
	const at = (place: number) => {
		const row = first<Row>(store, 'SELECT * FROM commits WHERE place = ?', [
			place,
		]);
		if (row === undefined) throw new Error(`no commit at place ${place}`);
		return fromRow(row);
	};
	const top = () => meta.number('top');
	const insert = (stored: Stored) =>
		store.run(
			'INSERT OR REPLACE INTO commits (id, place, parents, user, device, time, at, tree, blocks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
			[
				stored.id,
				stored.place,
				JSON.stringify(stored.parents),
				stored.author.user,
				stored.author.device,
				stored.time,
				stored.at,
				stored.tree,
				stored.blocks ? 1 : 0,
			],
		);

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
		placeOf: (id: string) =>
			first<{ place: number | null }>(
				store,
				'SELECT place FROM commits WHERE id = ?',
				[id],
			)?.place ?? undefined,
		textIn,
		/** The ids on `main` after place `from`, through place `to`. */
		idsAfter: (from: number, to = top()) =>
			store
				.all<{ id: string }>(
					'SELECT id FROM commits WHERE place > ? AND place <= ? ORDER BY place',
					[from, to],
				)
				.map((row) => row.id),
		/** `main`'s spelling of a path, by its folded identity. */
		spelling: (path: string) =>
			first<{ path: string }>(
				store,
				'SELECT path FROM spellings WHERE folded = ?',
				[fold(path)],
			)?.path ?? null,
		lastAuthor: (path: string): Author | null => {
			const row = first<{ user: string; device: string }>(
				store,
				'SELECT user, device FROM authors WHERE path = ?',
				[path],
			);
			return row === undefined ? null : { user: row.user, device: row.device };
		},
		/** Start history with a root commit whose tree is `tree`. */
		root(stored: Omit<Stored, 'place'>) {
			insert({ ...stored, place: 0 });
			meta.set('top', 0);
			meta.set('offset', 0);
			for (const path of trees.diff(trees.empty, stored.tree))
				store.run(
					'INSERT OR REPLACE INTO spellings (folded, path) VALUES (?, ?)',
					[fold(path), path],
				);
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
				files.map((f) => [
					f.path.split('/'),
					f.text === null ? null : keep(f.text),
				]),
			);
			const changed = files
				.map((f) => ({
					path: f.path,
					before: textIn(before.tree, f.path),
					after: f.text,
				}))
				.filter((f) => f.before !== f.after);
			const place = top() + 1;
			insert({ ...stored, place, tree });
			meta.set('top', place);
			meta.set('made', meta.number('made') + 1);
			for (const { path, after } of changed) {
				if (after === null) {
					// Only this spelling's row: a file's spelling never changes while it exists, so this is its only row.
					store.run('DELETE FROM spellings WHERE folded = ? AND path = ?', [
						fold(path),
						path,
					]);
				} else
					store.run(
						'INSERT OR REPLACE INTO spellings (folded, path) VALUES (?, ?)',
						[fold(path), path],
					);
				store.run(
					'INSERT OR REPLACE INTO authors (path, user, device) VALUES (?, ?, ?)',
					[path, stored.author.user, stored.author.device],
				);
			}
			return { tree, changed };
		},
		/** Drop places before `keep` (never `main` itself): positions a catch-up starts from, never what a write needs. */
		pruneBefore(keep: number) {
			const offset = meta.number('offset');
			if (keep <= offset) return;
			store.run('DELETE FROM commits WHERE place < ?', [keep]);
			meta.set('offset', keep);
		},
		/** Git has these texts: from now on they may go from the store once nothing kept names them. */
		inGit(hashes: Iterable<string>) {
			for (const hash of hashes)
				store.run('UPDATE blobs SET git = 1 WHERE hash = ?', [hash]);
		},
		/**
		 * Delete every tree node, and every text Git has, that no tree named
		 * by a kept commit or by `roots` reaches. Mark and sweep: what a kept
		 * tree reaches is walked once, shared subtrees included.
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
			for (const { tree } of store.all<{ tree: string }>(
				'SELECT DISTINCT tree FROM commits',
			))
				walk(tree);
			for (const tree of roots) walk(tree);
			for (const { hash } of store.all<{ hash: string }>(
				'SELECT hash FROM nodes',
			))
				if (!reached.has(hash)) {
					store.run('DELETE FROM nodes WHERE hash = ?', [hash]);
					cache.delete(hash);
				}
			for (const { hash } of store.all<{ hash: string }>(
				'SELECT hash FROM blobs WHERE git = 1',
			))
				if (!texts.has(hash))
					store.run('DELETE FROM blobs WHERE hash = ?', [hash]);
		},
		/** The newest place whose commit is older than `cutoff`, or -1. */
		newestBefore: (cutoff: number) =>
			first<{ place: number | null }>(
				store,
				'SELECT MAX(place) AS place FROM commits WHERE place IS NOT NULL AND at < ?',
				[cutoff],
			)?.place ?? -1,
	};
}
export type History = ReturnType<typeof openHistory>;
