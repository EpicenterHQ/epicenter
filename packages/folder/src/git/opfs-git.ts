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
 * Sync publishes the files itself, one guarded write at a time, as on the
 * desktop (ADR-0576); this store keeps only Git's own private files.
 */

import type { PromiseFsClient } from 'isomorphic-git';
import { PRIVATE_DIRECTORY } from '../boundary.js';
import {
	errorName,
	lookup,
	type OpfsFolder,
	readHandle,
	readPrivateFile,
	removePrivateFile,
	writePrivateFile,
} from '../opfs-store.js';
import type { CasResult } from './backend.js';
import { entryKey, parseIndex } from './index-file.js';

/** isomorphic-git's view of private Git state. */
export const GITDIR = '/git';
/** isomorphic-git's read-only view of the folder's files. */
export const WORKDIR = '/files';

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

/** A private file's bytes by `.git`-relative path, with empty read as absent where Git never stores empty. */
async function readGitFile(folder: OpfsFolder, path: string) {
	const root = await folder.existing();
	if (root === undefined) return undefined;
	const bytes = await readPrivateFile(root, path);
	if (bytes?.byteLength === 0 && emptyIsAbsent(`${GITDIR}/${path}`))
		return undefined;
	return bytes;
}

/** What `path` names in `folder`, which may not exist yet. */
async function find(folder: OpfsFolder, path: string) {
	const root = await folder.existing();
	return root === undefined
		? ({ kind: 'absent' } as const)
		: lookup(root, path);
}

/** Remove a private file of `folder`, if the folder is there. */
async function removeIn(folder: OpfsFolder, path: string) {
	const root = await folder.existing();
	if (root !== undefined) await removePrivateFile(root, path);
}

/**
 * One piece of Git work's filesystem view over `folder`; `flush` stores its
 * private writes.
 */
function createOpfsGitSession(folder: OpfsFolder): {
	readonly fs: PromiseFsClient;
	flush(): Promise<void>;
} {
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
		return rel === '' ? undefined : readGitFile(folder, rel);
	}

	async function gitChildren(path: string): Promise<string[] | undefined> {
		const rel = privatePath(path);
		const found = await find(
			folder,
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
			const found = await find(folder, rel);
			if (found.kind === 'directory') return statsFor('directory', 0);
			if (found.kind === 'file') {
				const file = await found.handle.getFile();
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
					const found = rel === undefined ? undefined : await find(folder, rel);
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
					const found = await find(folder, rel);
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
					(await readGitFile(folder, 'index').then(
						(stored) => stored !== undefined && sameIndexEntries(stored, value),
					));
				if (unchanged) {
					pending.delete(path);
					continue;
				}
				if (value === null) await removeIn(folder, privatePath(path));
				else
					await writePrivateFile(await folder.made(), privatePath(path), value);
				pending.delete(path);
			}
		},
	};
}

/**
 * Where a browser folder's private Git state lives: a filesystem view for
 * each piece of Git work, a private file's bytes by its `/git/...` path, and
 * a ref moved only if it still names `expected`.
 */
export function createOpfsGitStore({ folder }: { folder: OpfsFolder }) {
	const privatePath = (path: string) => path.slice(GITDIR.length + 1);

	const readPrivate = (path: string): Promise<Uint8Array | undefined> =>
		readGitFile(folder, privatePath(path));
	const writeRef = async (path: string, oid: string) =>
		writePrivateFile(
			await folder.made(),
			privatePath(path),
			encoder.encode(`${oid}\n`),
		);

	return {
		session: () => createOpfsGitSession(folder),
		readPrivate,
		async casRef(
			path: string,
			expected: string | undefined,
			next: string,
		): Promise<CasResult> {
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
	};
}
