/**
 * The folder port: what the folder engine (`engine.ts`) asks of a file
 * system, host-free. Two adapters implement it: memory (here), for the
 * property test, whose events and editors interleave with the engine at
 * every step on virtual time; and Bun (`bun/folder-fs.ts`), over `node:fs`.
 * Both pass `FOLDER_FS_CHECKS` (`fs.checks.ts`).
 *
 * Paths are relative to the root, `/`-separated, as the file system spells
 * them. The port reads, lists and watches; it changes a file only through
 * `replace` and `remove`, which keep one rule: **the engine never destroys
 * bytes it did not write.** Neither one overwrites or unlinks a file in
 * place. Each first renames whatever is at the path, at that instant, to a
 * scratch name in `.epicenter/tmp/` (capture by rename), and `replace` then
 * links its new bytes into the empty path, which fails, leaving theirs,
 * when an editor created the file meanwhile. What was captured is the
 * engine's to read and compare with what it last wrote there: equal, it was
 * the engine's own and may go (`drop`); different, it is a save that raced
 * and goes in as one. A writer still writing through an open descriptor
 * writes into the scratch file, so the engine looks at it again after a
 * quiet window before it drops it. For an instant the path is absent; the
 * editor matrix (`bun/folder.matrix.test.ts`) records how editors take it.
 *
 * Events are hints: `watch` names paths that may have changed, or `null`
 * when the scope is unknown (an overflow, an error, a name it could not
 * read), and the engine reads the file to learn what happened.
 */
import { Ok, type Result } from 'wellcrafted/result';
import { defineErrors, type InferErrors } from 'wellcrafted/error';

/** The folder the engine keeps for itself, never synced: its identity file and its scratch. */
export const OWN = '.epicenter';
/** Where captured and half-written files wait, on the same file system as the folder. */
export const SCRATCH = `${OWN}/tmp`;

/** One thing a walk or a stat finds. Symlinks are reported as such, never followed. */
export type Entry = { path: string; kind: 'file' | 'directory' | 'symlink' | 'other'; size: number; mtime: number; ino: number };

/** A captured file: its bytes, read when asked, and its mtime, so a file still being written through a descriptor is seen to be. */
export type Captured = { bytes: Blob; mtime: number };

/** What `replace` did: whether its bytes are at the path now (and the file it made, as a stat would find it), and the scratch name of what was there before (null: nothing was). */
export type Replaced = { written: boolean; entry: Entry | null; displaced: string | null };

export const FolderFsError = defineErrors({
	/** The file system refused a change for a reason other than a race (no room, no permission). */
	Failed: ({ path, cause }: { path: string; cause: unknown }) => ({ message: `${path} could not be changed: ${String(cause)}`, path, cause }),
});
export type FolderFsError = InferErrors<typeof FolderFsError>;

export type FolderFs = {
	/** Every entry under `prefix` ('' for the root), streamed, skipping directories `skip` names (by path) and never following a symlink. */
	walk(prefix: string, skip: (path: string) => boolean): AsyncIterable<Entry>;
	/** What is at `path` now, without following a symlink; null for nothing. */
	stat(path: string): Promise<Entry | null>;
	/** The names of the entries directly in directory `dir` ('' for the root), as the file system spells them; none when it is not a directory. */
	list(dir: string): Promise<string[]>;
	/** A regular file's bytes as a `Blob` read when asked (null: absent, or not a regular file). */
	read(path: string): Promise<Blob | null>;
	/**
	 * Put `bytes` at `path` by capture and link: what was there goes to
	 * `scratch` (a name `SCRATCH` holds), and the new bytes go in only if the
	 * path is still empty. Parent directories are made.
	 */
	replace(path: string, bytes: Blob, { scratch }: { scratch: string }): Promise<Result<Replaced, FolderFsError>>;
	/** Take what is at `path` to `scratch`: null when nothing was there. */
	remove(path: string, { scratch }: { scratch: string }): Promise<Result<string | null, FolderFsError>>;
	/** A captured file's bytes and mtime, or null when it is gone. */
	readScratch(scratch: string): Promise<Captured | null>;
	/** Put a captured file back at `path` if the path is empty (a crash's recovery); whether it went back. */
	restore(scratch: string, path: string): Promise<boolean>;
	/** Let a captured file go, once the engine has read it. */
	drop(scratch: string): Promise<void>;
	/** Scratch names left in `SCRATCH` (by a crash). */
	scratches(): Promise<string[]>;
	/** Be told which paths may have changed, or `null` for any; returns the function that stops it. A watch that fails for good calls `failed`. */
	watch(listener: (paths: string[] | null) => void, failed: (cause: unknown) => void): () => void;
};

// ============================================================================
// Memory
// ============================================================================

type MemoryFile = { bytes: Uint8Array; ino: number; mtime: number; kind: 'file' | 'symlink' };

/** How the memory file system's events arrive: each delayed, some dropped silently, some lost to an overflow (`null`). */
export type EventFaults = {
	/** Virtual ms before an event is delivered; events due together are delivered as one batch. */
	delay(): number;
	/** Drop this event without a trace (only a scan finds what it named). */
	drop(): boolean;
	/** Lose this event to an overflow: the listener hears `null`. */
	overflow(): boolean;
};

const decoder = new TextDecoder();
const parentsOf = (path: string) => {
	const parts = path.split('/');
	return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
};

/**
 * A file system in memory, case-sensitive and normalization-sensitive (as
 * Linux's), on the host's virtual clock. Every call takes one tick of that
 * clock before it acts, and `replace` takes two (capture, then link), so a
 * writer scheduled on the same clock can act between any two steps of the
 * engine. Writers outside the engine use `write`, `unlink` and `rename`.
 *
 * It checks the engine's rule as it goes: `drop` of a scratch file the
 * engine has not read since it last changed is a violation (bytes the
 * engine did not write, destroyed unread), and so is a change through
 * `replace` or `remove` to a path an ignore rule covers, or a file made by
 * `replace` whose path folds (as `fold` says) to another file's in the
 * folder when the call began.
 */
export function createMemoryFolderFs({
	after,
	now,
	faults = { delay: () => 0, drop: () => false, overflow: () => false },
	ignored = () => false,
	fold = null,
	step = () => 0,
}: {
	after: (ms: number, run: () => void) => void;
	now: () => number;
	faults?: EventFaults;
	/** Paths the engine must never change: a change through the engine's calls is a violation. */
	ignored?: (path: string) => boolean;
	/** The repository's folding of paths: the engine making a file whose path folds to another file's is a violation. */
	fold?: ((path: string) => string) | null;
	/** Virtual ms each call takes before it acts, so writers on the same clock land between the engine's steps. */
	step?: () => number;
}) {
	const files = new Map<string, MemoryFile>();
	const scratch = new Map<string, MemoryFile & { read: boolean }>();
	let inode = 1;
	const violations: string[] = [];
	const listeners = new Set<(paths: string[] | null) => void>();
	/** Events due at one virtual time, delivered as one batch. */
	const due = new Map<number, Set<string> | null>();

	/** Bumped by a crash: a call made before it never completes, as a process killed mid-call. */
	let epoch = 0;
	const tick = () => {
		const at = epoch;
		return new Promise<void>((resolve) =>
			after(step(), () => {
				if (at === epoch) resolve();
			}),
		);
	};
	function emit(...paths: string[]) {
		for (const path of paths) {
			if (faults.drop()) continue;
			const at = now() + faults.delay();
			const lost = faults.overflow();
			const batch = due.get(at);
			if (!due.has(at)) {
				due.set(at, lost ? null : new Set([path]));
				after(at - now(), () => {
					const paths = due.get(at);
					due.delete(at);
					for (const listener of listeners) listener(paths === null || paths === undefined ? null : [...paths]);
				});
			} else if (lost) due.set(at, null);
			else batch?.add(path);
		}
	}
	const entryOf = (path: string, file: MemoryFile): Entry => ({ path, kind: file.kind, size: file.bytes.byteLength, mtime: file.mtime, ino: file.ino });
	const isDirectory = (path: string) => {
		const prefix = `${path}/`;
		for (const key of files.keys()) if (key.startsWith(prefix)) return true;
		return false;
	};
	const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
	/** A path is free for a new file: nothing there, and no file where a parent directory must be. */
	const free = (path: string) => !files.has(path) && !isDirectory(path) && parentsOf(path).every((parent) => !files.has(parent));

	const port: FolderFs = {
		async *walk(prefix, skip) {
			await tick();
			const seen = new Set<string>();
			for (const path of [...files.keys()].sort()) {
				if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
				const parents = parentsOf(path).filter((parent) => prefix === '' || parent.length > prefix.length);
				if (parents.some(skip)) continue;
				for (const parent of parents)
					if (!seen.has(parent)) {
						seen.add(parent);
						yield { path: parent, kind: 'directory', size: 0, mtime: 0, ino: 0 };
					}
				const file = files.get(path);
				if (file !== undefined) yield entryOf(path, file);
			}
		},
		async stat(path) {
			await tick();
			const file = files.get(path);
			if (file !== undefined) return entryOf(path, file);
			return isDirectory(path) ? { path, kind: 'directory', size: 0, mtime: 0, ino: 0 } : null;
		},
		async list(dir) {
			await tick();
			const prefix = dir === '' ? '' : `${dir}/`;
			const names = new Set<string>();
			for (const path of files.keys()) if (path.startsWith(prefix)) names.add(path.slice(prefix.length).split('/')[0] ?? '');
			return [...names].sort();
		},
		async read(path) {
			await tick();
			const file = files.get(path);
			return file === undefined || file.kind !== 'file' ? null : new Blob([file.bytes.slice() as BlobPart]);
		},
		async replace(path, blob, { scratch: name }) {
			if (ignored(path)) violations.push(`the engine wrote ${path}, which is ignored`);
			// The folder as the engine last looked, just before this call: a file beside which it must not make one.
			const beside = fold === null || files.has(path) ? [] : [...files.keys()].filter((other) => other !== path && fold(other) === fold(path));
			const bytes = await bytesOf(blob);
			await tick();
			const there = files.get(path);
			if (there !== undefined) {
				files.delete(path);
				scratch.set(name, { ...there, read: false });
				emit(path);
			}
			// An editor may act here, between the capture and the link.
			await tick();
			if (!free(path)) return Ok({ written: false, entry: null, displaced: there === undefined ? null : name });
			const made: MemoryFile = { bytes, ino: inode++, mtime: now(), kind: 'file' };
			for (const other of beside) if (files.has(other)) violations.push(`the engine wrote ${path} beside ${other}`);
			files.set(path, made);
			emit(path);
			return Ok({ written: true, entry: entryOf(path, made), displaced: there === undefined ? null : name });
		},
		async remove(path, { scratch: name }) {
			if (ignored(path)) violations.push(`the engine removed ${path}, which is ignored`);
			await tick();
			const there = files.get(path);
			if (there === undefined) return Ok(null);
			files.delete(path);
			scratch.set(name, { ...there, read: false });
			emit(path);
			return Ok(name);
		},
		async readScratch(name) {
			await tick();
			const file = scratch.get(name);
			if (file === undefined) return null;
			file.read = true;
			return { bytes: new Blob([file.bytes.slice() as BlobPart]), mtime: file.mtime };
		},
		async restore(name, path) {
			await tick();
			const file = scratch.get(name);
			if (file === undefined || !free(path)) return false;
			scratch.delete(name);
			files.set(path, { ...file });
			emit(path);
			return true;
		},
		async drop(name) {
			await tick();
			const file = scratch.get(name);
			if (file !== undefined && !file.read) violations.push(`the engine dropped ${name} unread: ${JSON.stringify(decoder.decode(file.bytes)).slice(0, 80)}`);
			scratch.delete(name);
		},
		async scratches() {
			await tick();
			return [...scratch.keys()];
		},
		watch(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};

	return {
		port,
		/** What breaks the engine's rule, as found so far. */
		violations,
		// --------------------------------------------------------------------
		// Writers other than the engine: editors, a person in a shell
		// --------------------------------------------------------------------
		/** Write a whole file at once (created, or written in place on the same inode). */
		write(path: string, bytes: Uint8Array) {
			const there = files.get(path);
			if (there === undefined && !free(path)) return false;
			files.set(path, { bytes, ino: there?.ino ?? inode++, mtime: now(), kind: 'file' });
			emit(path);
			return true;
		},
		/** The text inode `ino` holds now, at its path or captured, or null. */
		inodeText(ino: number) {
			for (const file of [...files.values(), ...scratch.values()]) if (file.ino === ino) return decoder.decode(file.bytes);
			return null;
		},
		/** The inode at `path`, as a writer that opened it holds it. */
		inodeOf: (path: string) => files.get(path)?.ino ?? null,
		/**
		 * Write through an open descriptor: into whichever file holds inode
		 * `ino` now, at its path or captured in scratch (an editor writing in
		 * place after the engine took its file aside). False when no file holds it.
		 */
		writeInode(ino: number, bytes: Uint8Array) {
			for (const [path, file] of files)
				if (file.ino === ino) {
					files.set(path, { ...file, bytes, mtime: now() });
					emit(path);
					return true;
				}
			for (const [name, file] of scratch)
				if (file.ino === ino) {
					scratch.set(name, { ...file, bytes, mtime: now(), read: false });
					return true;
				}
			return false;
		},
		/** Make a symlink (its target's bytes as its content, for the record only). */
		symlink(path: string, target: string) {
			if (!free(path)) return false;
			files.set(path, { bytes: new TextEncoder().encode(target), ino: inode++, mtime: now(), kind: 'symlink' });
			emit(path);
			return true;
		},
		/** Change only the mtime. */
		touch(path: string) {
			const there = files.get(path);
			if (there === undefined) return false;
			files.set(path, { ...there, mtime: now() });
			emit(path);
			return true;
		},
		unlink(path: string) {
			if (!files.delete(path)) return false;
			emit(path);
			return true;
		},
		/** Rename a file over whatever is at `to`, or a directory with everything under it. */
		rename(from: string, to: string) {
			const file = files.get(from);
			if (file !== undefined) {
				if (isDirectory(to)) return false;
				files.delete(from);
				files.set(to, file);
				emit(from, to);
				return true;
			}
			const prefix = `${from}/`;
			const moving = [...files.keys()].filter((path) => path.startsWith(prefix));
			if (moving.length === 0 || files.has(to) || isDirectory(to)) return false;
			for (const path of moving) {
				const moved = `${to}/${path.slice(prefix.length)}`;
				files.set(moved, files.get(path) as MemoryFile);
				files.delete(path);
				emit(path, moved);
			}
			return true;
		},
		/** A file's bytes now, or null. */
		bytes: (path: string) => files.get(path)?.bytes ?? null,
		/** A file's text now, or null. */
		text: (path: string) => {
			const file = files.get(path);
			return file === undefined ? null : decoder.decode(file.bytes);
		},
		/** Every regular file's path. */
		paths: () => [...files].filter(([, file]) => file.kind === 'file').map(([path]) => path).sort(),
		/** Captured files not yet dropped. */
		scratchNames: () => [...scratch.keys()],
		/** Every captured file's text, for a check that a save is somewhere. */
		scratchTexts: () => [...scratch.values()].map((file) => decoder.decode(file.bytes)),
		/** Every file's text, ignored or not, symlinks aside. */
		texts: () => [...files].filter(([, file]) => file.kind === 'file').map(([path, file]) => [path, decoder.decode(file.bytes)] as const),
		/** The process using the port dies: every call in progress stops where it is, and never completes. */
		crash() {
			epoch++;
		},
	};
}
export type MemoryFolderFs = ReturnType<typeof createMemoryFolderFs>;
