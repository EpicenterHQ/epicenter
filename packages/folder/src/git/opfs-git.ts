/**
 * A browser folder's private Git state in `.git` of its origin private file
 * system directory (ADR-0497, ADR-0545).
 *
 * isomorphic-git sees one filesystem over the folder's one tree: `/files` is
 * the folder's files, read-only, without `.git`, and `/git` is `.git`. Git
 * never writes a folder file through it. Each session buffers its private
 * writes and flushes objects before anything else, so a ref or index never
 * names an object that is not stored. These writes are Git's own: they are
 * not content saves and are told to no other page.
 *
 * OPFS creates a file empty and fills it when its stream closes, while it
 * replaces an existing file whole. So an empty index, ref, or loose object
 * is one whose creation never published, and reads treat it as absent; Git
 * never writes those empty. `HEAD` is settled when the backend opens.
 *
 * The branch and the index change only inside the folder's Git Web Lock,
 * which every cooperating tab holds for index and branch work. The branch is
 * compared with the pinned value before it is replaced.
 *
 * An incoming fast-forward or merge publishes as on the desktop, and
 * nothing records it (ADR-0545). Admission checks the folder is still what
 * the clean check found, and that nothing the update does not empty, a
 * directory or a file no path names, is where it writes a file. Then
 * removals (pruning directories they emptied), any directory the update
 * emptied where it writes a file, writes, the index, and the branch. An
 * update cut off partway leaves files that differ from `HEAD`: status shows
 * them as changed, and the next Sync records them and merges with the
 * tracking ref.
 */

import type { PromiseFsClient } from 'isomorphic-git';
import { hashBytes } from '../capture.js';
import { describe, FileError } from '../errors.js';
import {
	applyChanges,
	captureFiles,
	errorName,
	holding,
	lookup,
	type OpfsDirectoryHandle,
	type OpfsLocks,
	PRIVATE_DIRECTORY,
	readHandle,
	readPrivateFile,
	removePrivateFile,
	walk,
	writePrivateFile,
} from '../opfs-store.js';
import { basename, dirname } from '../paths.js';
import {
	type CasResult,
	type IncomingPlan,
	type PublishResult,
	stoppedApplying,
} from './backend.js';
import {
	type BrowserGitStore,
	GITDIR,
	type GitFsSession,
	refValue,
	sameBytes,
	WORKDIR,
} from './browser-backend.js';
import { entryKey, parseIndex } from './index-file.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const INDEX = `${GITDIR}/index`;

/** An index, ref, or loose object Git never stores empty: empty is absent. */
const emptyIsAbsent = (path: string) =>
	path === INDEX ||
	path === `${GITDIR}/MERGE_HEAD` ||
	path === `${GITDIR}/ORIG_HEAD` ||
	path.startsWith(`${GITDIR}/refs/`) ||
	path.startsWith(`${GITDIR}/objects/`);

function failure(code: string, path: string): Error {
	return Object.assign(new Error(`${code}: ${path}`), { code });
}

/**
 * Stats that never match an index entry's cached ones. isomorphic-git trusts
 * whole-second times and sizes to skip reading a file; a fresh inode on every
 * look makes it hash the bytes instead.
 */
function statsFor(kind: 'file' | 'directory', size: number, mtimeMs = 0) {
	return {
		isFile: () => kind === 'file',
		isDirectory: () => kind === 'directory',
		isSymbolicLink: () => false,
		mode: kind === 'file' ? 0o100644 : 0o40755,
		size,
		mtimeMs,
		ctimeMs: mtimeMs,
		uid: 0,
		gid: 0,
		ino: crypto.getRandomValues(new Uint32Array(1))[0]!,
		dev: 0,
	};
}

/**
 * Each index entry's mode, object ID, stage, and path: everything except the
 * cached file stats. `undefined` for anything but a version 2 index, the
 * version isomorphic-git writes.
 */
function indexEntries(bytes: Uint8Array): string[] | undefined {
	return parseIndex(bytes)?.map(entryKey);
}

/** Whether two index files differ only in cached file stats. */
function sameIndexEntries(left: Uint8Array, right: Uint8Array): boolean {
	const [a, b] = [indexEntries(left), indexEntries(right)];
	return (
		a !== undefined &&
		b !== undefined &&
		a.length === b.length &&
		a.every((entry, index) => entry === b[index])
	);
}

type OpfsGitSession = GitFsSession & {
	/** The index bytes this session wrote and has not flushed. */
	unflushedIndex(): Uint8Array | undefined;
};

/** A private file's bytes by `.git`-relative path, with empty read as absent where Git never stores empty. */
async function readGitFile(root: OpfsDirectoryHandle, path: string) {
	const bytes = await readPrivateFile(root, path);
	if (bytes?.byteLength === 0 && emptyIsAbsent(`${GITDIR}/${path}`))
		return undefined;
	return bytes;
}

function createOpfsGitSession(root: OpfsDirectoryHandle): OpfsGitSession {
	/** Private writes not yet stored, by `/git/...` path; `null` removes. */
	const pending = new Map<string, Uint8Array | null>();

	const normalize = (path: string) => {
		const parts: string[] = [];
		for (const part of path.split('/')) {
			if (part === '' || part === '.') continue;
			if (part === '..') parts.pop();
			else parts.push(part);
		}
		return `/${parts.join('/')}`;
	};
	const isGit = (path: string) =>
		path === GITDIR || path.startsWith(`${GITDIR}/`);
	const isWork = (path: string) =>
		path === WORKDIR || path.startsWith(`${WORKDIR}/`);
	/** The private path inside `.git`, `''` for `.git` itself. */
	const privatePath = (path: string) =>
		path === GITDIR ? '' : path.slice(GITDIR.length + 1);
	/** The folder path, or `undefined` for anything under `.git`. */
	const folderPath = (path: string) => {
		const relative = path === WORKDIR ? '' : path.slice(WORKDIR.length + 1);
		const first = relative.split('/')[0];
		return first === PRIVATE_DIRECTORY ? undefined : relative;
	};

	async function gitValue(path: string): Promise<Uint8Array | undefined> {
		if (pending.has(path)) return pending.get(path) ?? undefined;
		const rel = privatePath(path);
		return rel === '' ? undefined : readGitFile(root, rel);
	}

	async function gitChildren(path: string): Promise<string[] | undefined> {
		const rel = privatePath(path);
		const found = await lookup(
			root,
			rel === '' ? PRIVATE_DIRECTORY : `${PRIVATE_DIRECTORY}/${rel}`,
		);
		const names = new Set<string>();
		if (found.kind === 'directory')
			for await (const entry of found.handle.values()) names.add(entry.name);
		const prefix = `${path}/`;
		for (const [key, value] of pending) {
			if (!key.startsWith(prefix)) continue;
			const rest = key.slice(prefix.length);
			const name = rest.split('/')[0]!;
			if (value === null) {
				if (!rest.includes('/')) names.delete(name);
			} else names.add(name);
		}
		if (found.kind !== 'directory' && names.size === 0) return undefined;
		return [...names];
	}

	async function stat(rawPath: string) {
		const path = normalize(rawPath);
		if (isGit(path)) {
			const value = await gitValue(path);
			if (value !== undefined) return statsFor('file', value.byteLength);
			if ((await gitChildren(path)) !== undefined)
				return statsFor('directory', 0);
			throw failure('ENOENT', path);
		}
		if (isWork(path)) {
			const rel = folderPath(path);
			if (rel === undefined) throw failure('ENOENT', path);
			const found = await lookup(root, rel);
			if (found.kind === 'directory') return statsFor('directory', 0);
			if (found.kind === 'file') {
				const file = (await found.handle.getFile()) as {
					size: number;
					lastModified?: number;
				};
				return statsFor('file', file.size, file.lastModified);
			}
			throw failure('ENOENT', path);
		}
		if (path === '/') return statsFor('directory', 0);
		throw failure('ENOENT', path);
	}

	/** Map a missing entry to the code isomorphic-git expects. */
	async function guarded<T>(path: string, work: () => Promise<T>): Promise<T> {
		try {
			return await work();
		} catch (cause) {
			if ((cause as { code?: string }).code !== undefined) throw cause;
			const name = errorName(cause);
			if (name === 'NotFoundError') throw failure('ENOENT', path);
			if (name === 'TypeMismatchError') throw failure('ENOTDIR', path);
			throw cause;
		}
	}

	const promises = {
		// isomorphic-git calls this with no path to learn that it returns a
		// promise, so even that refusal must be a rejection.
		async readFile(rawPath?: string, options?: string | { encoding?: string }) {
			if (rawPath === undefined) throw failure('EINVAL', '');
			const path = normalize(rawPath);
			return guarded(path, async () => {
				let value: Uint8Array | undefined;
				if (isGit(path)) value = await gitValue(path);
				else if (isWork(path)) {
					const rel = folderPath(path);
					const found = rel === undefined ? undefined : await lookup(root, rel);
					if (found?.kind === 'file') value = await readHandle(found.handle);
				}
				if (value === undefined) throw failure('ENOENT', path);
				const encoding =
					typeof options === 'string' ? options : options?.encoding;
				return encoding ? decoder.decode(value) : value;
			});
		},
		async writeFile(rawPath: string, data: Uint8Array | string) {
			const path = normalize(rawPath);
			if (!isGit(path) || path === GITDIR) throw failure('EPERM', path);
			pending.set(
				path,
				typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data),
			);
		},
		unlink(rawPath: string) {
			const path = normalize(rawPath);
			return guarded(path, async () => {
				if (!isGit(path)) throw failure('EPERM', path);
				if ((await gitValue(path)) === undefined) throw failure('ENOENT', path);
				pending.set(path, null);
			});
		},
		readdir(rawPath: string) {
			const path = normalize(rawPath);
			return guarded(path, async () => {
				if (isGit(path)) {
					if ((await gitValue(path)) !== undefined)
						throw failure('ENOTDIR', path);
					const names = await gitChildren(path);
					if (names === undefined) throw failure('ENOENT', path);
					return names;
				}
				if (isWork(path)) {
					const rel = folderPath(path);
					if (rel === undefined) throw failure('ENOENT', path);
					const found = await lookup(root, rel);
					if (found.kind === 'file') throw failure('ENOTDIR', path);
					if (found.kind !== 'directory') throw failure('ENOENT', path);
					const names: string[] = [];
					for await (const entry of found.handle.values())
						if (rel !== '' || entry.name !== PRIVATE_DIRECTORY)
							names.push(entry.name);
					return names;
				}
				if (path === '/') return ['files', 'git'];
				throw failure('ENOENT', path);
			});
		},
		async mkdir(rawPath: string) {
			const path = normalize(rawPath);
			if (!isGit(path)) throw failure('EPERM', path);
		},
		async rmdir(rawPath: string) {
			const path = normalize(rawPath);
			if (!isGit(path)) throw failure('EPERM', path);
		},
		stat: (rawPath: string) => guarded(rawPath, () => stat(rawPath)),
		lstat: (rawPath: string) => guarded(rawPath, () => stat(rawPath)),
		async readlink(rawPath: string): Promise<string> {
			throw failure('EINVAL', rawPath);
		},
		async symlink(_target: string, rawPath: string) {
			throw failure('EPERM', rawPath);
		},
		async chmod() {},
	};

	return {
		fs: { promises } as unknown as PromiseFsClient,
		unflushedIndex() {
			return pending.get(INDEX) ?? undefined;
		},
		async flush() {
			// Objects first: nothing may name an object before it is stored.
			const order = [...pending.keys()].sort(
				(a, b) =>
					Number(!a.startsWith(`${GITDIR}/objects/`)) -
					Number(!b.startsWith(`${GITDIR}/objects/`)),
			);
			for (const path of order) {
				const value = pending.get(path);
				if (value === undefined) continue;
				// Stats here are never cached (see `statsFor`), so a status look
				// rewrites every entry's stats. An index whose entries did not
				// change is not stored again: its bytes stay what a clean check saw.
				const unchanged =
					path === INDEX &&
					value !== null &&
					(await readGitFile(root, 'index').then(
						(stored) => stored !== undefined && sameIndexEntries(stored, value),
					));
				if (unchanged) {
					pending.delete(path);
					continue;
				}
				if (value === null) await removePrivateFile(root, privatePath(path));
				else await writePrivateFile(root, privatePath(path), value);
				pending.delete(path);
			}
		},
	};
}

export function createOpfsGitStore({
	root,
	locks,
	filesLock,
	branch,
	landed,
}: {
	root: OpfsDirectoryHandle;
	locks: OpfsLocks;
	/** Held while an update publishes, so no save lands between checks and writes. */
	filesLock: string;
	branch: string;
	/** Paths one landed step reached, as soon as it lands. */
	landed: (paths: readonly string[]) => void;
}): BrowserGitStore<OpfsGitSession> {
	const branchKey = `${GITDIR}/refs/heads/${branch}`;
	const privatePath = (path: string) => path.slice(GITDIR.length + 1);

	const readPrivate = (path: string) => readGitFile(root, privatePath(path));
	const readRef = async (path: string) => refValue(await readPrivate(path));
	const writeRef = (path: string, oid: string) =>
		writePrivateFile(root, privatePath(path), encoder.encode(`${oid}\n`));

	/**
	 * Every file below the directory `path`, portable or not, and every
	 * directory from `path` down, deepest first.
	 */
	async function below(path: string) {
		const at = await lookup(root, path);
		const files: string[] = [];
		const directories = [path];
		if (at.kind !== 'directory') return { files, directories: [] };
		await walk(at.handle, `${path}/`, {
			file: (file) => void files.push(file),
			directory: (directory) => void directories.push(directory),
		});
		return { files, directories: directories.reverse() };
	}

	/**
	 * Where the update writes a file, what is in the way. A file above it is
	 * in nobody's way when the update removes that file. A directory is
	 * `emptied` when every file in it is one the update removes and it and
	 * every directory in it held such a file: removed after the removals,
	 * before the writes. Any other directory, or a file in one that no path
	 * can name, is `blocked`, and the update is refused before it writes.
	 */
	async function inTheWay(plan: IncomingPlan) {
		const removed = new Set(
			plan.changes.flatMap((change) =>
				change.kind === 'remove' ? [change.path] : [],
			),
		);
		const heldRemoved = (directory: string) =>
			[...removed].some((path) => path.startsWith(`${directory}/`));
		const emptied: string[] = [];
		for (const change of plan.changes) {
			if (change.kind === 'remove' || change.kind === 'move') continue;
			const at = await lookup(root, change.path);
			if (at.kind === 'underFile' && !removed.has(at.ancestor))
				return { blocked: FileError.Exists({ path: at.ancestor }).error };
			if (at.kind !== 'directory') continue;
			const inside = await below(change.path);
			if (
				!inside.directories.every(heldRemoved) ||
				!inside.files.every((file) => removed.has(file))
			)
				return { blocked: FileError.NotAFile({ path: change.path }).error };
			emptied.push(change.path);
		}
		return { emptied };
	}

	/**
	 * Remove each directory in `emptied` with the directories inside it,
	 * deepest first, where a write is about to put a file. Pruning after a
	 * removal does this as it goes; this finishes pruning that stopped. Only
	 * empty directories are removed, so a file in one stops this with an
	 * error and nothing in it is lost.
	 */
	async function removeEmptied(
		emptied: readonly string[],
	): Promise<FileError | undefined> {
		for (const path of emptied) {
			try {
				for (const directory of (await below(path)).directories) {
					const parent = await lookup(root, dirname(directory));
					if (parent.kind === 'directory')
						await parent.handle.removeEntry(basename(directory));
				}
			} catch (cause) {
				return FileError.Io({
					path,
					operation: 'remove the directory the update emptied at',
					cause,
				}).error;
			}
		}
		return undefined;
	}

	return {
		session: () => createOpfsGitSession(root),
		readPrivate,
		async casRef(path, expected, next): Promise<CasResult> {
			// Every cooperating writer moves refs inside the Git Web Lock, so
			// nothing lands between this read and the write. An empty ref is
			// one whose creation never published: it names no commit.
			const value = await readPrivate(path);
			const actual =
				value === undefined ? undefined : decoder.decode(value).trim();
			if (actual !== expected) return { ok: false, actual };
			await writeRef(path, next);
			return { ok: true };
		},
		publishIncoming(plan, prepared) {
			return holding(locks, filesLock, () => publish(plan, prepared));
		},
	};

	/** Under the Git lock and the files lock: admission, files, index, branch. */
	async function publish(
		plan: IncomingPlan,
		prepared: OpfsGitSession,
	): Promise<PublishResult> {
		// Admission: the folder is still exactly what the clean check found.
		// Every portable file has its captured hash, nothing new appeared, the
		// index is the bytes shown to match the pinned head, and the branch
		// still names it. Ordinary saves wait on the files lock held here.
		const captured = await captureFiles(root);
		if (captured.unreadable.length > 0)
			return { status: 'refused', error: captured.unreadable[0]!.error };
		for (const [file, bytes] of captured.files) {
			const expected = plan.baseline.files.get(file);
			if (expected === undefined)
				return {
					status: 'refused',
					error: FileError.Exists({ path: file }).error,
				};
			const actual = await hashBytes(bytes);
			if (actual !== expected)
				return {
					status: 'refused',
					error: FileError.Conflict({
						path: file,
						expectedSha256: expected,
						actualSha256: actual,
					}).error,
				};
		}
		for (const [file, expected] of plan.baseline.files)
			if (!captured.files.has(file))
				return {
					status: 'refused',
					error: FileError.Conflict({
						path: file,
						expectedSha256: expected,
						actualSha256: undefined,
					}).error,
				};
		if (!sameBytes(await readPrivate(INDEX), plan.baseline.index))
			return { status: 'indexChanged' };
		const head = await readRef(branchKey);
		if (head !== plan.expectedHead)
			return { status: 'branchMoved', actual: head };
		// Captured files are portable files only, so what else is in the way
		// is looked for here.
		const way = await inTheWay(plan);
		if (way.blocked !== undefined)
			return { status: 'refused', error: way.blocked };

		// Removals first (pruning directories they emptied), then directories
		// the update emptied where it writes a file, then writes, then the
		// index, then the branch. A step that stops leaves what landed as
		// changed files for the next Sync (ADR-0545).
		const removals = plan.changes.filter((change) => change.kind === 'remove');
		const writes = plan.changes.filter((change) => change.kind !== 'remove');
		const reached: string[] = [];
		for (const group of [removals, writes]) {
			if (group === writes) {
				const error = await removeEmptied(way.emptied);
				if (error !== undefined) return stoppedApplying(group, error, reached);
			}
			if (group.length === 0) continue;
			const { error } = await applyChanges(root, group, landed, {
				prune: true,
			});
			if (error !== null) return stoppedApplying(group, error, reached);
			reached.push(...group.map((change) => (change as { path: string }).path));
		}
		const interrupted = (error: string): PublishResult => ({
			status: 'interrupted',
			landed: plan.paths,
			error,
		});
		try {
			const target = prepared.unflushedIndex();
			if (target !== undefined) await writePrivateFile(root, 'index', target);
		} catch (cause) {
			return interrupted(
				`the Git index could not be updated: ${describe(cause)}`,
			);
		}
		try {
			const moved = await readRef(branchKey);
			if (moved !== plan.expectedHead)
				return interrupted(
					`the branch moved to ${moved ?? 'no commit'} before it could be advanced`,
				);
			await writeRef(branchKey, plan.nextHead);
		} catch (cause) {
			return interrupted(
				`the branch could not be advanced: ${describe(cause)}`,
			);
		}
		return { status: 'published' };
	}
}
