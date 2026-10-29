/**
 * The folder engine: a folder on disk as a projection of one replica, kept
 * by the same engine the browser runs (ADR-0695, as amended by ADR-0697).
 * Host-free: the host gives the folder port (`fs.ts`), the replica and its
 * database, the device's blob store, a way to bring a blob's bytes to this
 * device, and its timer and clock.
 *
 * Two directions, one rule each.
 *
 * - **Out.** When the replica's text for a path changes, the engine writes
 *   it to the file, but only over bytes it wrote itself: the file still
 *   hashes to what the record says the engine last wrote or read there.
 *   Otherwise the file holds a save the engine has not read yet, and it
 *   reads that first. The write itself is the port's capture and link, so a
 *   save that lands in the instant between the look and the write is
 *   captured, never destroyed, and goes in as a save.
 * - **In.** When a file's bytes differ from the record, that is a save: a
 *   Markdown file becomes a `write` over the text the engine last wrote
 *   there, any other file a blob write (sealed into the device store first)
 *   expecting the pointer the engine last wrote, a missing file a delete.
 *
 * Both are one function, `reconcile(paths, call)`: read and hash each file,
 * compare it with the record and with the replica's `mine`, hand the
 * replica the saves it finds, then project what `mine` became. `call` says
 * only how those saves are grouped: `'each'` (live hints and scans) makes
 * each save its own call, except a vanished path and an appeared one with
 * the same bytes, a rename, which go together; a message (`epicenter
 * commit -m`) makes every save one call that carries it. Events are only
 * hints naming paths to look at; a file whose hash equals the record is
 * nothing, so the engine's own writes never echo.
 *
 * The record, `"epicenter/disk"` in the replica's database: per path (as
 * the engine writes it, the replica's spelling), the bytes' SHA-256, their
 * size, mtime and inode as a stat found them, when it was recorded, and the
 * text: a note's text, or a blob's pointer, so what needs projecting is one
 * indexed comparison with the replica's `mine`. A save's record and the
 * replica's change commit in one transaction, so neither is ever ahead of
 * the other. Each write is journaled in `"epicenter/displaced"` before it
 * happens (what the record held, and what the engine is writing), so a
 * crash between a capture and its link puts the file back, and one between
 * the link and the record is known for the engine's own write, never read
 * as a save.
 *
 * Paths whose any segment starts with `.` are neither read nor written, nor
 * are the editor droppings `DROPPINGS` names. A file the repository cannot
 * take is held, with why, and never sent: a symlink or other file that is
 * not regular (never followed), a `.md` file that is not UTF-8, and a file
 * whose path equals another file's after NFC and case folding (the
 * repository folds paths, a case-sensitive disk does not), until the person
 * renames one. The engine never writes such a pair itself.
 */
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import type { Logger } from 'wellcrafted/logger';
import { UPLOAD_REFUSALS } from '../client/uploads.js';
import { createHasher, type BlobStore, type Sealed } from '../client/blobs.js';
import type { Replica } from '../client/replica.js';
import { fold, isNote } from '../core/door.js';
import { parsePointer, writePointer } from '../core/markdown.js';
import type { SqlDriver } from '../sql.js';
import { first } from '../sql.js';
import { type Entry, type FolderFs, OWN } from './fs.js';

// ============================================================================
// What the engine never touches
// ============================================================================

/**
 * Editor droppings that are not dot files and persist under names a person
 * could not mean (the editor matrix, `bun/folder.matrix.test.ts`, records
 * each): vim's backup `name~` and its write probe `4913`, Emacs's
 * `#name#`, Office's `~$name`, JetBrains' safe-write temporaries, and
 * partial downloads.
 */
export const DROPPINGS: readonly RegExp[] = [/~$/, /^4913$/, /^#.*#$/, /^~\$/, /___jb_(tmp|old)___$/, /\.(part|crdownload)$/];

/** Whether the engine leaves `path` alone: a dot segment, or a dropping's name. */
export function ignored(path: string) {
	const segments = path.split('/');
	const name = segments.at(-1) ?? '';
	return segments.some((segment) => segment.startsWith('.')) || DROPPINGS.some((dropping) => dropping.test(name));
}

// ============================================================================
// The record
// ============================================================================

const SCHEMA = `
CREATE TABLE IF NOT EXISTS "epicenter/disk" (
	path TEXT PRIMARY KEY,
	fold TEXT NOT NULL,
	hash TEXT NOT NULL,
	size INTEGER NOT NULL,
	mtime REAL NOT NULL,
	ino INTEGER NOT NULL,
	at REAL NOT NULL,
	text TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS "epicenter/disk/fold" ON "epicenter/disk" (fold);
CREATE TABLE IF NOT EXISTS "epicenter/displaced" (name TEXT PRIMARY KEY, path TEXT NOT NULL, hash TEXT, text TEXT, writing TEXT, removing INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE IF NOT EXISTS "epicenter/held" (path TEXT PRIMARY KEY, fold TEXT NOT NULL, reason TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS "epicenter/folder" (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
`;

const FolderDiagnostic = defineErrors({
	/** A file in the scratch directory that no capture of this engine journaled: left for the person. */
	StrayScratch: ({ scratch }: { scratch: string }) => ({ message: `${OWN}/tmp/${scratch} is not one of the engine's captures; it is left as it is`, scratch }),
	/** A job of the engine threw: what it was reconciling is read again by the next scan. */
	Failed: ({ cause }: { cause: unknown }) => ({ message: `The folder engine failed: ${extractErrorMessage(cause)}`, cause }),
	/** The folder's watch could not be opened again: the engine stops. */
	WatchFailed: ({ cause }: { cause: unknown }) => ({ message: `The folder can no longer be watched: ${extractErrorMessage(cause)}`, cause }),
});

/** What the engine last wrote or read at a path. `text` is a note's text or a blob's pointer. */
type Recorded = { hash: string; size: number; mtime: number; ino: number; at: number; text: string };

/** A racy-Git window: a file modified this close to when it was recorded may have changed within the same mtime tick, so it is hashed. */
const RACY = 2_000;
/** Paths reconciled at once in a scan, so a scan's memory is a batch, not the folder. */
const BATCH = 256;

/** What a look at one path found on disk. */
type Look =
	| { path: string; kind: 'absent' }
	| { path: string; kind: 'unreadable'; reason: string }
	| { path: string; kind: 'note'; hash: string; text: string; entry: Entry }
	| { path: string; kind: 'blob'; hash: string; size: number; entry: Entry };

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

async function hashOf(bytes: Blob) {
	const hasher = createHasher();
	const reader = bytes.stream().getReader();
	let size = 0;
	for (let read = await reader.read(); !read.done; read = await reader.read()) {
		hasher.update(read.value);
		size += read.value.byteLength;
	}
	return { hash: hasher.digest(), size };
}
const hashText = (text: string) => {
	const hasher = createHasher();
	hasher.update(encoder.encode(text));
	return hasher.digest();
};
/** The hash a replica text projects to: a note's bytes, or the oid a pointer names. */
function hashOfMine(path: string, text: string) {
	if (isNote(path)) return hashText(text);
	return parsePointer(text)?.oid ?? hashText(text);
}

/** How the saves one reconcile finds are grouped: each its own call (a rename's two halves together), or all one call with a message. */
export type Call = 'each' | { message: string };

export type FolderEngineOptions = {
	fs: FolderFs;
	replica: Replica;
	/** The replica's database: the record lives beside the replica's tables. */
	driver: SqlDriver;
	/** The device's blob store: a blob save is sealed here before the replica hears of it. */
	store: BlobStore<Blob>;
	/** Bring the bytes a pointer names to the device store (phase 8's read path); false when they cannot be had now. */
	fetch: (path: string, pointer: Sealed) => Promise<boolean>;
	after: (ms: number, run: () => void) => void;
	now: () => number;
	/** How long a path's events must be quiet before it is read. */
	quiet?: number;
	/** How often a full scan runs while live (null: only at startup and after a lost event). */
	scanEvery?: number | null;
	/** Called when a file is held (the repository cannot take it, with why), or is not any more (reason null). */
	onHeld?: (path: string, reason: string | null) => void;
	log?: Logger;
};

/** The default quiet window, in ms (the platform facts and the editor matrix set it). */
export const QUIET = 150;

/** Why a file whose path folds to another file's is held. */
export const TWIN = 'another file has this name in different letters';

export function createFolderEngine({ fs, replica, driver, store, fetch, after, now, quiet = QUIET, scanEvery = null, onHeld, log }: FolderEngineOptions) {
	driver.exec(SCHEMA);
	/** Stopped: a job not started does nothing, and a job in progress writes nothing more. */
	let stopped = false;
	const meta = {
		get: (key: string) => first<{ value: string }>(driver, 'SELECT value FROM "epicenter/folder" WHERE key = ?', [key])?.value ?? null,
		set: (key: string, value: string) => driver.run('INSERT OR REPLACE INTO "epicenter/folder" (key, value) VALUES (?, ?)', [key, value]),
	};
	let next = Number(meta.get('scratch') ?? 0);
	/** A scratch name no run has used: the counter is stored before the name is. */
	const scratchName = () => {
		next++;
		meta.set('scratch', String(next));
		return `d-${next}`;
	};

	const recorded = (path: string): Recorded | null => first<Recorded>(driver, 'SELECT hash, size, mtime, ino, at, text FROM "epicenter/disk" WHERE path = ?', [path]) ?? null;
	function setRecord(path: string, value: Omit<Recorded, 'at'> | null) {
		live();
		if (value === null) driver.run('DELETE FROM "epicenter/disk" WHERE path = ?', [path]);
		else
			driver.run('INSERT OR REPLACE INTO "epicenter/disk" (path, fold, hash, size, mtime, ino, at, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
				path,
				fold(path),
				value.hash,
				value.size,
				value.mtime,
				value.ino,
				now(),
				value.text,
			]);
	}
	const mineAt = (path: string) => first<{ text: string | null }>(driver, 'SELECT text FROM "epicenter/files" WHERE path = ?', [path])?.text ?? null;

	function hold(path: string, reason: string | null) {
		const was = first<{ reason: string }>(driver, 'SELECT reason FROM "epicenter/held" WHERE path = ?', [path])?.reason ?? null;
		if (was === reason) return;
		if (reason === null) driver.run('DELETE FROM "epicenter/held" WHERE path = ?', [path]);
		else driver.run('INSERT OR REPLACE INTO "epicenter/held" (path, fold, reason) VALUES (?, ?, ?)', [path, fold(path), reason]);
		onHeld?.(path, reason);
	}

	/** Other spellings of `path` the engine knows of: recorded, in the replica, or held. */
	function spellings(path: string) {
		const folded = fold(path.normalize('NFC'));
		const known = ['"epicenter/disk"', '"epicenter/files"', '"epicenter/held"'].flatMap((table) => driver.all<{ path: string }>(`SELECT path FROM ${table} WHERE fold = ?`, [folded]).map((row) => row.path));
		return [...new Set(known)].filter((other) => other !== path);
	}

	/**
	 * The folder's directory listings as one reconcile reads them, each read
	 * once, and kept as the engine itself makes and removes files: where
	 * another file's path folds to a path is a question for the folder.
	 */
	function listings() {
		/** Per directory read, its names by their folded form. */
		const read = new Map<string, Promise<Map<string, Set<string>>>>();
		const folded = (name: string) => fold(name.normalize('NFC'));
		const names = (dir: string) => {
			let found = read.get(dir);
			if (found === undefined) {
				found = fs.list(dir).then((list) => {
					const byFold = new Map<string, Set<string>>();
					for (const name of list) byFold.set(folded(name), (byFold.get(folded(name)) ?? new Set()).add(name));
					return byFold;
				});
				read.set(dir, found);
			}
			return found;
		};
		const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
		const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);
		return {
			/** Paths in the folder other than `path` that fold to it, one directory level at a time. */
			async beside(path: string) {
				let at = [''];
				for (const segment of path.split('/')) {
					const next: string[] = [];
					for (const dir of at) for (const name of (await names(dir)).get(folded(segment)) ?? []) next.push(dir === '' ? name : `${dir}/${name}`);
					at = next;
				}
				return at.filter((other) => other !== path);
			},
			/** The engine made `path` (and any directory above it) or removed it. */
			async made(path: string) {
				for (let child = path, dir = parent(path); ; child = dir, dir = parent(dir)) {
					if (read.has(dir)) {
						const byFold = await names(dir);
						byFold.set(folded(base(child)), (byFold.get(folded(base(child))) ?? new Set()).add(base(child)));
					}
					if (dir === '') return;
				}
			},
			async gone(path: string) {
				if (read.has(parent(path))) (await names(parent(path))).get(folded(base(path)))?.delete(base(path));
			},
		};
	}
	type Listings = ReturnType<typeof listings>;

	/**
	 * What the folder holds at `path` beside its other spellings: the spelling
	 * the engine knows, when the file system resolves both to one file (a
	 * case- or normalization-insensitive one); and whether another file's path
	 * folds to this one's (`twin`).
	 */
	async function spellingAt(path: string, listed: Listings): Promise<{ path: string; twin: boolean }> {
		const known = spellings(path);
		const others = [...new Set([...known, ...(await listed.beside(path))])];
		if (others.length === 0) return { path, twin: false };
		const here = await fs.stat(path);
		let twin = false;
		for (const other of others) {
			const there = await fs.stat(other);
			if (there === null || there.kind === 'directory') continue;
			// One file under two spellings: the one the engine already knows names it.
			if (here !== null && here.ino === there.ino && here.ino !== 0) return { path: known.includes(other) ? other : path, twin: false };
			twin = true;
		}
		return { path, twin };
	}

	/** Look again at the other spellings of `path` the engine knows: one held beside it, or one it could not write beside it, may be free now. */
	function hintSpellings(path: string) {
		const others = spellings(path);
		if (others.length > 0) hint(others);
	}

	// --------------------------------------------------------------------------
	// Looking
	// --------------------------------------------------------------------------

	async function look(path: string): Promise<Look> {
		const before = await fs.stat(path);
		if (before === null || before.kind === 'directory') return { path, kind: 'absent' };
		if (before.kind !== 'file') return { path, kind: 'unreadable', reason: `not a regular file (${before.kind})` };
		const bytes = await fs.read(path);
		if (bytes === null) return { path, kind: 'absent' };
		if (isNote(path)) {
			const buffer = new Uint8Array(await bytes.arrayBuffer());
			let text: string;
			try {
				text = decoder.decode(buffer);
			} catch {
				return { path, kind: 'unreadable', reason: 'not UTF-8 text' };
			}
			const hasher = createHasher();
			hasher.update(buffer);
			return { path, kind: 'note', hash: hasher.digest(), text, entry: { ...before, size: buffer.byteLength } };
		}
		const { hash, size } = await hashOf(bytes);
		return { path, kind: 'blob', hash, size, entry: { ...before, size } };
	}
	const hashLooked = (seen: Look) => (seen.kind === 'note' || seen.kind === 'blob' ? seen.hash : null);

	// --------------------------------------------------------------------------
	// Reconcile: the one function
	// --------------------------------------------------------------------------

	/** One save found: the change for the replica and the record it leaves. */
	type Save = { path: string; text: string | null; over: string | null; record: Omit<Recorded, 'at'> | null; refuse?: string };

	/** What `reconcile` found and did: the paths whose saves went to the replica. */
	type Reconciled = { saved: string[] };

	/** Seal a blob's bytes into the device store; its pointer, or null when the file changed or vanished meanwhile (the next look takes it). */
	async function seal(seen: Extract<Look, { kind: 'blob' }>): Promise<Sealed | null> {
		const bytes = await fs.read(seen.path);
		if (bytes === null) return null;
		const sealed = await store.seal(bytes.stream() as ReadableStream<Uint8Array>);
		if (sealed.error !== null) {
			log?.warn(sealed.error);
			return null;
		}
		return sealed.data;
	}

	async function saveOf(seen: Look, record: Recorded | null): Promise<Save | null> {
		const over = record?.text ?? null;
		switch (seen.kind) {
			case 'absent':
				return { path: seen.path, text: null, over, record: null };
			case 'note':
				return { path: seen.path, text: seen.text, over, record: { hash: seen.hash, size: seen.entry.size, mtime: seen.entry.mtime, ino: seen.entry.ino, text: seen.text } };
			case 'blob': {
				if (seen.size > replica.blobLimit()) {
					// RULE: bytes past the repository's limit are not sealed: the pointer is saved and held at once with the upload track's reason (phase 8), so the file stays and says why.
					const pointer = writePointer({ oid: seen.hash, size: seen.size });
					return { path: seen.path, text: pointer, over, refuse: UPLOAD_REFUSALS[422], record: { hash: seen.hash, size: seen.size, mtime: seen.entry.mtime, ino: seen.entry.ino, text: pointer } };
				}
				const sealed = await seal(seen);
				if (sealed === null) return null;
				const pointer = writePointer(sealed);
				// The sealed bytes are what goes in; if the file changed since it was hashed, its stat no longer matches, and the next look reads it.
				const entry = sealed.oid === seen.hash ? seen.entry : { ...seen.entry, ino: 0 };
				return { path: seen.path, text: pointer, over, record: { hash: sealed.oid, size: sealed.size, mtime: entry.mtime, ino: entry.ino, text: pointer } };
			}
			case 'unreadable':
				return null;
		}
	}

	/** Every write to the database or the folder checks this first: a stopped engine (a crash, in a test) changes nothing more. */
	function live() {
		if (stopped) throw new Error('the folder engine has stopped');
	}

	/** Hand the replica one call's saves, with their records, in one transaction. */
	function hand(saves: Save[], message?: string) {
		live();
		if (saves.length === 0) return;
		driver.transaction(() => {
			for (const save of saves) setRecord(save.path, save.record);
			replica.writeAll(Object.fromEntries(saves.map((save) => [save.path, save.text])), {
				over: Object.fromEntries(saves.map((save) => [save.path, save.over])),
				...(message === undefined ? {} : { message }),
			});
			for (const save of saves) if (save.refuse !== undefined && save.record !== null) replica.refused(save.record.hash, save.refuse);
		});
	}

	/**
	 * Group `each`-mode saves into calls: a vanished path and an appeared one
	 * with the same bytes, found in one reconcile, are one rename.
	 */
	function groupSaves(saves: { save: Save; was: string | null }[]): Save[][] {
		const calls: Save[][] = [];
		const vanished = saves.filter((s) => s.save.text === null && s.was !== null);
		const paired = new Set<Save>();
		for (const appeared of saves) {
			if (appeared.save.text === null || appeared.was !== null || appeared.save.record === null) continue;
			const half = vanished.find((v) => !paired.has(v.save) && v.was === appeared.save.record?.hash);
			if (half === undefined) continue;
			paired.add(half.save);
			paired.add(appeared.save);
			calls.push([half.save, appeared.save]);
		}
		for (const { save } of saves) if (!paired.has(save)) calls.push([save]);
		return calls;
	}

	/**
	 * Reconcile `paths` (as on disk): every difference from the record is a
	 * save, grouped by `call`; then what the replica shows is projected.
	 */
	async function reconcile(paths: Iterable<string>, call: Call): Promise<Reconciled> {
		const found: { save: Save; was: string | null }[] = [];
		const looked: string[] = [];
		const given = [...new Set(paths)].filter((path) => !ignored(path));
		const listed = listings();
		for (const named of given) {
			const { path, twin } = await spellingAt(named, listed);
			// RULE: a file modified within the last quiet window may be half written (an in-place save between its truncate and its bytes): it is read once it has been still for one. A commit reads the disk as it is: its timing is its caller's.
			if (call === 'each') {
				const still = await fs.stat(path);
				if (still?.kind === 'file' && now() - still.mtime < quiet) {
					hint([named]);
					continue;
				}
			}
			const seen = await look(path);
			looked.push(path);
			const record = recorded(path);
			const disk = hashLooked(seen);
			if (seen.kind === 'unreadable') {
				hold(path, seen.reason);
				continue;
			}
			// Gone: another spelling held beside it, or one the engine could not write beside it, is looked at again.
			if (seen.kind === 'absent') hintSpellings(path);
			// RULE: a file whose path another file's path folds to is a save the repository cannot take: held, until the person renames one.
			const kept = twin && seen.kind !== 'absent' && disk !== (record?.hash ?? null);
			hold(path, kept ? TWIN : null);
			if (disk === (record?.hash ?? null)) {
				// The same as the record. A stat that moved (a touch), or one recorded within the racy window, is recorded again, so the next scan skips the file.
				if (seen.kind !== 'absent' && record !== null && (record.mtime !== seen.entry.mtime || record.ino !== seen.entry.ino || seen.entry.mtime + RACY >= record.at))
					setRecord(path, { ...record, mtime: seen.entry.mtime, ino: seen.entry.ino, size: seen.entry.size });
				continue;
			}
			if (kept) continue;
			const mine = mineAt(path);
			if (disk === (mine === null ? null : hashOfMine(path, mine))) {
				// The file is what the replica shows (a crash between a write and its record lands here): recorded, nothing saved.
				driver.transaction(() =>
					setRecord(path, seen.kind === 'absent' || mine === null ? null : { hash: disk as string, size: seen.entry.size, mtime: seen.entry.mtime, ino: seen.entry.ino, text: mine }),
				);
				continue;
			}
			const save = await saveOf(seen, record);
			if (save !== null) found.push({ save, was: record?.hash ?? null });
		}
		const calls = call === 'each' ? groupSaves(found) : [found.map((f) => f.save)];
		// Each call is its own group, and all of them commit to the database at once, cut into the unsent commit once: one write to disk per reconcile, not per save.
		replica.batch(() => {
			for (const saves of calls) hand(saves, call === 'each' ? undefined : call.message);
		});
		for (const path of looked) await project(path, listed);
		return { saved: found.map((f) => f.save.path) };
	}

	// --------------------------------------------------------------------------
	// Projection: writing only over the engine's own bytes
	// --------------------------------------------------------------------------

	/** Paths whose blob bytes could not be fetched yet, and how long until the next try. */
	const fetching = new Map<string, number>();

	/** Write what the replica shows at `path` to the file, if the file is still what the engine last wrote there. */
	async function project(path: string, listed: Listings) {
		if (ignored(path)) return;
		const record = recorded(path);
		const mine = mineAt(path);
		if ((mine ?? null) === (record?.text ?? null)) return;
		// A file that differs from the record holds a save not read yet: a later reconcile reads it first.
		const there = await fs.stat(path);
		if ((there === null) !== (record === null)) return hint([path]);
		// RULE: the engine never makes a file whose path folds to another file's in the folder: it waits until that one is gone (renamed by the person, or the engine's own, removed).
		if (there === null && mine !== null && (await spellingAt(path, listed)).twin) return;
		if (there !== null && record !== null && (there.ino !== record.ino || there.size !== record.size || there.mtime !== record.mtime)) {
			const seen = await look(path);
			if (hashLooked(seen) !== record.hash) return hint([path]);
		}
		let bytes: Blob | null = null;
		if (mine !== null) {
			if (isNote(path)) bytes = new Blob([mine]);
			else {
				const pointer = parsePointer(mine);
				if (pointer === null) return;
				bytes = await store.read(pointer.oid);
				if (bytes === null) {
					// RULE: a blob's bytes are fetched and verified before the file is written; until then the file stays as it was.
					if (!(await fetch(path, pointer))) return retryFetch(path);
					fetching.delete(path);
					bytes = await store.read(pointer.oid);
					if (bytes === null) return retryFetch(path);
				}
			}
		}
		// Mine may have moved while bytes were fetched: project what it is now.
		if (mineAt(path) !== mine) return project(path, listed);
		live();
		const name = scratchName();
		driver.run('INSERT INTO "epicenter/displaced" (name, path, hash, text, writing, removing) VALUES (?, ?, ?, ?, ?, ?)', [name, path, record?.hash ?? null, record?.text ?? null, mine, mine === null ? 1 : 0]);
		const written = () => driver.run('UPDATE "epicenter/displaced" SET writing = NULL, removing = 0 WHERE name = ?', [name]);
		if (bytes === null) {
			const removed = await fs.remove(path, { scratch: name });
			if (removed.error !== null) {
				log?.warn(removed.error);
				driver.run('DELETE FROM "epicenter/displaced" WHERE name = ?', [name]);
				return;
			}
			driver.transaction(() => {
				setRecord(path, null);
				written();
			});
			displaced(name, removed.data);
			await listed.gone(path);
			hintSpellings(path);
			return;
		}
		const replaced = await fs.replace(path, bytes, { scratch: name });
		if (replaced.error !== null) {
			log?.warn(replaced.error);
			driver.run('DELETE FROM "epicenter/displaced" WHERE name = ?', [name]);
			return;
		}
		const { entry } = replaced.data;
		if (replaced.data.written) await listed.made(path);
		if (replaced.data.written && entry !== null && mine !== null)
			driver.transaction(() => {
				setRecord(path, { hash: hashOfMine(path, mine), size: entry.size, mtime: entry.mtime, ino: entry.ino, text: mine });
				written();
			});
		else {
			// RULE: not written: a writer made the file while the capture had the path empty, so it saw nothing there. The record says so, and the file is read as a create, merged with what the replica shows; what was captured is read on its own.
			driver.transaction(() => {
				setRecord(path, null);
				written();
			});
			hint([path]);
		}
		displaced(name, replaced.data.displaced);
	}

	function retryFetch(path: string) {
		const wait = Math.min((fetching.get(path) ?? 500) * 2, 60_000);
		fetching.set(path, wait);
		after(wait, () => hint([path]));
	}

	/**
	 * What a capture took from a path, which the engine expected to be what
	 * its journal row says: its own bytes go once they have been still for a
	 * quiet window (a writer still holding the file open writes into them);
	 * anything else is a save that raced, made over what the record held, and
	 * goes in as one.
	 */
	function displaced(name: string, scratch: string | null) {
		if (scratch === null) {
			driver.run('DELETE FROM "epicenter/displaced" WHERE name = ?', [name]);
			return;
		}
		after(quiet, () => enqueue(() => recheck(name)));
	}

	/** Take a captured file's bytes in: a save if they are not what was expected there, which they become. */
	async function ingestScratch(name: string, path: string, hash: string | null, over: string | null, bytes: Blob) {
		const { hash: held, size } = await hashOf(bytes);
		if (held === hash) return;
		let text: string;
		if (isNote(path)) {
			try {
				text = decoder.decode(new Uint8Array(await bytes.arrayBuffer()));
			} catch {
				// Bytes that are no text cannot be a note's save: they stay in scratch, named, for the person.
				hold(path, `a save that is not UTF-8 text was set aside at ${OWN}/tmp/${name}`);
				driver.run('UPDATE "epicenter/displaced" SET hash = ? WHERE name = ?', [held, name]);
				return;
			}
		} else {
			const sealed = await store.seal(bytes.stream() as ReadableStream<Uint8Array>);
			if (sealed.error !== null) {
				log?.warn(sealed.error);
				return;
			}
			text = writePointer(sealed.data);
		}
		live();
		driver.transaction(() => {
			replica.writeAll({ [path]: text }, { over: { [path]: over } });
			driver.run('UPDATE "epicenter/displaced" SET hash = ?, text = ? WHERE name = ?', [held, isNote(path) ? text : writePointer({ oid: held, size }), name]);
		});
		hint([path]);
	}

	/** Read a captured file once it is still: what it holds is a save if it is not what was expected; then it goes. */
	async function recheck(name: string) {
		const row = first<{ path: string; hash: string | null; text: string | null }>(driver, 'SELECT path, hash, text FROM "epicenter/displaced" WHERE name = ?', [name]);
		if (row === undefined) return;
		const captured = await fs.readScratch(name);
		const again = () => void after(quiet, () => enqueue(() => recheck(name)));
		if (captured !== null) {
			// RULE: the quiet rule holds for a captured file too: one modified within the last quiet window may be half written (an in-place save between its truncate and its bytes), and is read once it has been still for one.
			if (now() - captured.mtime < quiet) return again();
			await ingestScratch(name, row.path, row.hash, row.text, captured.bytes);
			// Written into meanwhile: read again once it is still.
			if ((await fs.readScratch(name))?.mtime !== captured.mtime) return again();
			// Bytes that are no text stay where the person was told they are.
			if (first(driver, 'SELECT 1 FROM "epicenter/held" WHERE path = ? AND reason LIKE ?', [row.path, `%${name}`]) !== undefined) return;
			await fs.drop(name);
		}
		driver.run('DELETE FROM "epicenter/displaced" WHERE name = ?', [name]);
	}

	/** After a crash: every capture journaled goes back where its path is empty, or is read as a save; temporaries go. */
	async function recover() {
		const names = new Set(await fs.scratches());
		// A write the record never heard of: if the file holds what the engine was writing, it is the engine's own, and recorded; if the capture happened and the file is another's, it was made over nothing (the rule in `project`).
		for (const row of driver.all<{ name: string; path: string; writing: string | null; removing: number }>('SELECT name, path, writing, removing FROM "epicenter/displaced" WHERE writing IS NOT NULL OR removing = 1')) {
			const seen = await look(row.path);
			driver.transaction(() => {
				if (row.removing === 1 && seen.kind === 'absent') setRecord(row.path, null);
				else if (row.writing !== null && (seen.kind === 'note' || seen.kind === 'blob') && seen.hash === hashOfMine(row.path, row.writing))
					setRecord(row.path, { hash: seen.hash, size: seen.entry.size, mtime: seen.entry.mtime, ino: seen.entry.ino, text: row.writing });
				else if (names.has(row.name) && seen.kind !== 'absent') setRecord(row.path, null);
				driver.run('UPDATE "epicenter/displaced" SET writing = NULL, removing = 0 WHERE name = ?', [row.name]);
			});
		}
		const rows = driver.all<{ name: string; path: string; hash: string | null; text: string | null }>('SELECT name, path, hash, text FROM "epicenter/displaced"');
		for (const row of rows) {
			if (!names.has(row.name)) {
				driver.run('DELETE FROM "epicenter/displaced" WHERE name = ?', [row.name]);
				continue;
			}
			if ((await fs.stat(row.path)) === null && (await fs.restore(row.name, row.path))) {
				driver.run('DELETE FROM "epicenter/displaced" WHERE name = ?', [row.name]);
				continue;
			}
			await recheck(row.name);
		}
		for (const name of names) if (!rows.some((row) => row.name === name)) log?.warn(FolderDiagnostic.StrayScratch({ scratch: name }).error);
	}

	// --------------------------------------------------------------------------
	// Scans
	// --------------------------------------------------------------------------

	/** Paths whose record and the replica's `mine` differ: what projection owes. */
	const owedProjection = () => [
		...driver.all<{ path: string }>('SELECT d.path FROM "epicenter/disk" d LEFT JOIN "epicenter/files" f ON f.path = d.path WHERE f.text IS NOT d.text').map((row) => row.path),
		...driver
			.all<{ path: string }>('SELECT f.path FROM "epicenter/files" f WHERE f.text IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "epicenter/disk" d WHERE d.path = f.path)')
			.map((row) => row.path),
	];

	/**
	 * The paths a scan must reconcile: a file whose stat differs from the
	 * record (or is within the racy window), a record no file answers, and
	 * what projection owes. Deletes are found by records the walk did not
	 * visit, in a temporary table, not a set in memory.
	 */
	async function* scanned(): AsyncGenerator<string> {
		driver.exec('CREATE TEMP TABLE IF NOT EXISTS "folder/visited" (path TEXT PRIMARY KEY)');
		driver.run('DELETE FROM temp."folder/visited"');
		/** Entries walked and not yet looked at: a batch is recorded as visited in one write, then compared. */
		let walked: Entry[] = [];
		const compare = function* () {
			driver.transaction(() => {
				for (const entry of walked) driver.run('INSERT OR IGNORE INTO temp."folder/visited" (path) VALUES (?)', [entry.path]);
			});
			for (const entry of walked) {
				const record = recorded(entry.path);
				const same = record !== null && entry.kind === 'file' && record.size === entry.size && record.mtime === entry.mtime && record.ino === entry.ino && entry.mtime + RACY < record.at;
				if (!same) yield entry.path;
			}
			walked = [];
		};
		for await (const entry of fs.walk('', ignored)) {
			if (entry.kind === 'directory' || ignored(entry.path)) continue;
			walked.push(entry);
			if (walked.length >= BATCH) yield* compare();
		}
		yield* compare();
		for (const { path } of driver.all<{ path: string }>('SELECT path FROM "epicenter/disk" WHERE path NOT IN (SELECT path FROM temp."folder/visited")')) yield path;
		driver.run('DELETE FROM temp."folder/visited"');
		// Held files are looked at again: one renamed or removed is held no longer.
		for (const { path } of driver.all<{ path: string }>('SELECT path FROM "epicenter/held"')) yield path;
		yield* owedProjection();
	}

	/** Scan the whole folder: each save found is its own call. */
	async function scan() {
		let batch: string[] = [];
		for await (const path of scanned()) {
			batch.push(path);
			if (batch.length >= BATCH) {
				await reconcile(batch, 'each');
				batch = [];
			}
		}
		await reconcile(batch, 'each');
	}

	// --------------------------------------------------------------------------
	// Hints and the work queue
	// --------------------------------------------------------------------------

	let queue: Promise<void> = Promise.resolve();
	let queued = 0;
	function enqueue(job: () => Promise<unknown>) {
		queued++;
		const run = async () => {
			try {
				if (!stopped) await job();
			} catch (cause) {
				log?.error(FolderDiagnostic.Failed({ cause }).error);
			} finally {
				queued--;
			}
		};
		const ran = queue.then(run);
		queue = ran;
		return ran;
	}

	/** Paths hinted and not yet read, with when they were last hinted. */
	const pending = new Map<string, number>();
	let armed = false;
	let scanAsked = false;
	function arm(ms: number) {
		if (armed || stopped) return;
		armed = true;
		after(ms, () => {
			armed = false;
			void enqueue(drain);
		});
	}
	function hint(paths: string[] | null) {
		if (stopped) return;
		if (paths === null) {
			scanAsked = true;
			return arm(quiet);
		}
		for (const path of paths) if (!ignored(path)) pending.set(path, now());
		if (pending.size > 0) arm(quiet);
	}

	/** Read the paths whose events have been quiet for a window; a file still being written waits another. */
	async function drain() {
		if (scanAsked) {
			scanAsked = false;
			pending.clear();
			await scan();
			return;
		}
		const ready: string[] = [];
		for (const [path, at] of [...pending]) {
			if (now() - at < quiet) continue;
			const entry = await fs.stat(path);
			// RULE: a file modified within the last quiet window is still being written: it is read once it has been still for one.
			if (entry !== null && entry.kind === 'file' && now() - entry.mtime < quiet) continue;
			pending.delete(path);
			if (entry?.kind === 'directory') {
				for await (const inside of fs.walk(path, ignored)) if (inside.kind !== 'directory') ready.push(inside.path);
			} else ready.push(path);
			// A directory that moved or went: every record under it.
			for (const { path: under } of driver.all<{ path: string }>('SELECT path FROM "epicenter/disk" WHERE path >= ? AND path < ?', [`${path}/`, `${path}0`])) ready.push(under);
		}
		if (ready.length > 0) await reconcile(ready, 'each');
		if (pending.size > 0) arm(quiet);
	}

	// What the replica changes is projected: the paths go through the same reconcile.
	const unwatch = replica.watch((paths) => {
		const owed = paths.filter((path) => !ignored(path) && mineAt(path) !== (recorded(path)?.text ?? null));
		if (owed.length > 0) void enqueue(() => reconcile(owed, 'each'));
	});

	let unwatchFs: (() => void) | null = null;
	let failure: unknown = null;
	function periodic() {
		if (scanEvery === null || stopped) return;
		after(scanEvery, () => {
			if (stopped) return;
			void enqueue(scan).then(periodic);
		});
	}

	return {
		/** Recover from a crash, scan, then watch: the folder is live until `stop`. */
		async start({ watch = true }: { watch?: boolean } = {}) {
			await enqueue(recover);
			await enqueue(scan);
			if (!watch) return;
			unwatchFs = fs.watch(hint, (cause) => {
				// RULE: a watch that cannot be opened again stops the engine with the error, never a silent poll.
				failure = cause;
				stopped = true;
				log?.error(FolderDiagnostic.WatchFailed({ cause }).error);
			});
			periodic();
		},
		/** Run one scan now (startup, after a lost event, periodically). */
		scan: () => enqueue(scan),
		/** Hints from outside the watch (a test, a host that learns of a change another way). */
		hint,
		/**
		 * Every difference from the record as one call carrying `message`:
		 * the paths that went to the replica (none: nothing differed).
		 */
		async commit(message: string) {
			let saved: string[] = [];
			await enqueue(async () => {
				await recover();
				const paths: string[] = [];
				for await (const path of scanned()) paths.push(path);
				saved = (await reconcile(paths, { message })).saved;
			});
			return saved;
		},
		/** Resolves once nothing hinted, queued or captured is left to do. */
		async idle() {
			for (;;) {
				await queue;
				if (queued === 0 && pending.size === 0 && !armed && !scanAsked) return;
				await new Promise<void>((resolve) => after(quiet, resolve));
			}
		},
		/** Files in the folder the repository cannot take, with why. */
		held: () => driver.all<{ path: string; reason: string }>('SELECT path, reason FROM "epicenter/held" ORDER BY path'),
		/** Why the engine stopped on its own (its watch failed), or null. */
		failure: () => failure,
		/** Stop at once, mid-work, as a killed process does: nothing more is written (the property test's crash). */
		kill() {
			stopped = true;
			unwatchFs?.();
			unwatch();
		},
		/** Stop watching and wait for the work in hand. */
		async stop() {
			unwatchFs?.();
			unwatch();
			await queue;
			stopped = true;
		},
	};
}
export type FolderEngine = ReturnType<typeof createFolderEngine>;
