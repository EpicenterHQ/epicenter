/**
 * A browser folder's private Git state in `.git` of its origin private file
 * system directory (ADR-0474, ADR-0497).
 *
 * isomorphic-git sees one filesystem over the folder's one tree: `/files` is
 * the folder's files, read-only, without `.git`, and `/git` is `.git`. Git
 * never writes a folder file through it. Each session buffers its private
 * writes and flushes objects before anything else, so a ref or index never
 * names an object that is not stored. These writes are Git's own: they are
 * not content saves and send no file hints.
 *
 * OPFS creates a file empty and fills it when its stream closes, while it
 * replaces an existing file whole. So an empty index, ref, or loose object
 * is one whose creation never published, and reads treat it as absent; Git
 * never writes those empty. `HEAD` is settled when the backend opens. Other
 * private files get no such reading: an empty incoming record means its
 * admission never finished, and is reported as that.
 *
 * The branch and the index change only inside the folder's Git Web Lock,
 * which every cooperating tab holds for index and branch work. The branch is
 * compared with the pinned value before it is replaced.
 *
 * An incoming fast-forward or merge publishes in steps. Admission checks the
 * folder is still what the clean check found, and that nothing the update
 * does not empty, a directory or a file no path names, is where it writes a
 * file, the same assessment recovery makes. It gives the folder a valid index
 * if it has none, pins both commits under `refs/epicenter/incoming/`, and
 * records `.git/epicenter-incoming.json`: an operation ID, the branch, the
 * head it was admitted over, and the commit it publishes. Only after that
 * record's stream closed does any authored file change: removals first
 * (pruning directories they emptied), then any directory the update emptied
 * where it writes a file, then writes, then the index, then the branch. Changed paths, target bytes, and the target index are derived from
 * the two commits' trees. The record is removed once everything reads back
 * as the published commit; a step whose outcome is unknown leaves it.
 *
 * A record that remains is pending until someone asks to recover it. Nothing
 * resumes it implicitly. Ordinary saves continue; staging, commits, and new
 * incoming updates wait. Recovery removes an empty (never admitted) record,
 * clears a record whose branch already names the published commit without
 * touching files, and over the admitted head writes each changed path at
 * its before state and keeps each at its after state. A path, the index, the
 * branch, or the record itself holding anything else is refused and named,
 * and nothing is written.
 */

import type { PromiseFsClient } from 'isomorphic-git';
import * as git from 'isomorphic-git';
import type { FileChange } from '../boundary.js';
import { hashBytes } from '../capture.js';
import {
	describe,
	FileError,
	type FileStep,
	UnconfirmedWrite,
} from '../errors.js';
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
import type {
	CasResult,
	IncomingPlan,
	PendingIncoming,
	PublishResult,
	RecordedIncoming,
	RecoverIncomingResult,
} from './backend.js';
import {
	type BrowserGitStore,
	GITDIR,
	type GitFsSession,
	indexTo,
	refValue,
	sameBytes,
	WORKDIR,
} from './browser-backend.js';
import { capturedIndexMatchesHead } from './captured-index.js';
import { entryKey, parseIndex } from './index-file.js';
import {
	commitTree,
	type ObjectAccess,
	readBlob,
	readTreeFiles,
	type TreeFile,
} from './objects.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const INDEX = `${GITDIR}/index`;
/** The pending incoming update's record, inside `.git`. */
const INCOMING_RECORD = 'epicenter-incoming.json';
/** Refs that keep both commits of a pending update reachable. */
const PIN_EXPECTED = 'refs/epicenter/incoming/expected';
const PIN_NEXT = 'refs/epicenter/incoming/next';

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

/** A valid version 2 index with no entries. */
async function emptyIndex(): Promise<Uint8Array> {
	const header = new Uint8Array([
		0x44, 0x49, 0x52, 0x43, 0, 0, 0, 2, 0, 0, 0, 0,
	]);
	const checksum = new Uint8Array(
		await crypto.subtle.digest('SHA-1', header as Uint8Array<ArrayBuffer>),
	);
	const bytes = new Uint8Array(header.byteLength + checksum.byteLength);
	bytes.set(header);
	bytes.set(checksum, header.byteLength);
	return bytes;
}

export type OpfsGitSession = GitFsSession & {
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

export function createOpfsGitSession(
	root: OpfsDirectoryHandle,
): OpfsGitSession {
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

/**
 * The stored record: the four fields of a pending update, `null` for no
 * head. A record an earlier version wrote for a merge left unfinished also
 * has `merge`; it is no longer read, so it is unreadable and kept for review.
 */
type StoredRecord = {
	readonly operationId: string;
	readonly branch: string;
	readonly expectedHead: string | null;
	readonly nextHead: string;
	readonly merge?: unknown;
};

const OID = /^[0-9a-f]{40}$/;

function parseRecord(bytes: Uint8Array): RecordedIncoming {
	const value = JSON.parse(decoder.decode(bytes)) as Partial<StoredRecord>;
	if (
		typeof value.operationId !== 'string' ||
		typeof value.branch !== 'string' ||
		!(value.expectedHead === null || OID.test(value.expectedHead ?? '')) ||
		!OID.test(value.nextHead ?? '')
	)
		throw new Error('it is not an incoming update record');
	if (value.merge !== undefined)
		throw new Error(
			'it records a merge left unfinished, which this version no longer publishes; remove it with Git',
		);
	return {
		state: 'recorded',
		operationId: value.operationId,
		branch: value.branch,
		expectedHead: value.expectedHead ?? undefined,
		nextHead: value.nextHead as string,
	};
}

function storedRecord(pending: RecordedIncoming): StoredRecord {
	return {
		operationId: pending.operationId,
		branch: pending.branch,
		expectedHead: pending.expectedHead ?? null,
		nextHead: pending.nextHead,
	};
}

/** How the folder stands against a pending update admitted over its head. */
type Assessment = {
	/** Every path the update changes. */
	readonly changed: readonly string[];
	/** Removals still to make, at their before state. */
	readonly removals: readonly FileChange[];
	/** Writes still to make, at their before state. */
	readonly writes: readonly FileChange[];
	/** Paths, or the index, at neither state. */
	readonly third: readonly string[];
	/** Whether the index already holds the published commit's entries. */
	readonly indexDone: boolean;
	/** Changed paths the published commit does not have. */
	readonly leaving: ReadonlySet<string>;
	/**
	 * Paths the update writes that are directories it empties now: removed
	 * after the removals, before the writes.
	 */
	readonly emptied: readonly string[];
};

/** What a path holds, as recovery compares it with two trees. */
type Found =
	| { readonly kind: 'file'; readonly oid: string }
	| { readonly kind: 'absent' }
	| { readonly kind: 'directory' }
	| { readonly kind: 'underFile'; readonly ancestor: string };

const stepOf = (change: FileChange): FileStep =>
	change.kind === 'remove'
		? { kind: 'remove', path: change.path }
		: { kind: 'write', path: (change as { path: string }).path };

export function createOpfsGitStore({
	root,
	locks,
	filesLock,
	branch,
	landed,
}: {
	root: OpfsDirectoryHandle;
	locks: OpfsLocks;
	/** Held while files publish or recover, so no save lands between checks and writes. */
	filesLock: string;
	branch: string;
	/** Paths one landed step reached, as soon as it lands. */
	landed: (paths: readonly string[]) => void;
}): BrowserGitStore<OpfsGitSession> {
	const branchKey = `${GITDIR}/refs/heads/${branch}`;
	const branchPath = `${PRIVATE_DIRECTORY}/refs/heads/${branch}`;
	const recordPath = `${PRIVATE_DIRECTORY}/${INCOMING_RECORD}`;
	const indexPath = `${PRIVATE_DIRECTORY}/index`;
	const privatePath = (path: string) => path.slice(GITDIR.length + 1);

	const readPrivate = (path: string) => readGitFile(root, privatePath(path));
	const readRef = async (path: string) => refValue(await readPrivate(path));
	const writeRef = (path: string, oid: string) =>
		writePrivateFile(root, privatePath(path), encoder.encode(`${oid}\n`));

	async function readRecord(): Promise<PendingIncoming | undefined> {
		const bytes = await readPrivateFile(root, INCOMING_RECORD);
		if (bytes === undefined) return undefined;
		if (bytes.byteLength === 0) return { state: 'unadmitted' };
		try {
			return parseRecord(bytes);
		} catch (cause) {
			return { state: 'unreadable', reason: describe(cause) };
		}
	}

	/** Remove the record, then its pins. The pins only keep commits reachable. */
	async function clearRecord() {
		await removePrivateFile(root, INCOMING_RECORD);
		for (const pin of [PIN_NEXT, PIN_EXPECTED])
			await removePrivateFile(root, pin).catch(() => {});
	}

	/** What `path` holds: a file's blob ID, nothing, a directory, or a file above it. */
	async function found(path: string): Promise<Found> {
		const at = await lookup(root, path);
		if (at.kind === 'file')
			return {
				kind: 'file',
				oid: (await git.hashBlob({ object: await readHandle(at.handle) })).oid,
			};
		if (at.kind === 'underFile')
			return { kind: 'underFile', ancestor: at.ancestor };
		return at.kind === 'directory' ? { kind: 'directory' } : { kind: 'absent' };
	}

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

	async function treeFiles(access: ObjectAccess, commit: string | undefined) {
		if (commit === undefined) return new Map<string, TreeFile>();
		return readTreeFiles(access, await commitTree(access, commit));
	}

	/**
	 * Recovery's writes carry no expectation (a removal without a hash, an
	 * `overwrite`): it assesses and applies under the files lock, which every
	 * save of this origin holds, so no save lands between them. OPFS has no
	 * writer outside that lock, and ignores expectations anyway.
	 *
	 * Compare the files and the index with the two commits' trees. A changed
	 * path is at its before state when it holds its before blob; when it was
	 * absent before, also when the only thing in the way is a file the update
	 * removes, or a directory the update empties: every file in it is one
	 * the update removes, still at its before state, and it and every
	 * directory in it held a file the update removes. A directory no removed
	 * file lived in, empty or not, was made by someone else. Anything else is
	 * a third state: an empty file where nothing was is one, since its writer
	 * cannot be told.
	 */
	async function assess(
		pending: RecordedIncoming,
		access: ObjectAccess,
	): Promise<Assessment> {
		const before = await treeFiles(access, pending.expectedHead);
		const after = await treeFiles(access, pending.nextHead);
		const changed = [...new Set([...before.keys(), ...after.keys()])]
			.filter((path) => before.get(path)?.oid !== after.get(path)?.oid)
			.sort();
		const removed = new Set(
			changed.filter((path) => after.get(path) === undefined),
		);
		const state = new Map<string, Found>();
		for (const path of changed) state.set(path, await found(path));
		const atBefore = (path: string) => {
			const now = state.get(path);
			return now?.kind === 'file' && now.oid === before.get(path)?.oid;
		};
		const heldRemoved = (directory: string) =>
			[...removed].some((path) => path.startsWith(`${directory}/`));
		const removals: FileChange[] = [];
		const writes: FileChange[] = [];
		const third: string[] = [];
		const emptied: string[] = [];
		for (const path of changed) {
			const now = state.get(path)!;
			const target = after.get(path)?.oid;
			const wasAbsent = before.get(path) === undefined;
			if (target === undefined) {
				// Kept as the update leaves it: no file here. A directory above
				// one already gone stays even when empty: it cannot be told from
				// one a person made since, and an empty directory changes no file.
				if (now.kind !== 'file') continue;
				if (now.oid === before.get(path)?.oid)
					removals.push({ kind: 'remove', path });
				else third.push(path);
				continue;
			}
			if (now.kind === 'file' && now.oid === target) continue;
			let ready = now.kind === 'file' && now.oid === before.get(path)?.oid;
			if (wasAbsent && now.kind === 'absent') ready = true;
			if (wasAbsent && now.kind === 'underFile')
				ready = removed.has(now.ancestor) && atBefore(now.ancestor);
			if (wasAbsent && now.kind === 'directory') {
				const inside = await below(path);
				ready =
					inside.directories.every(heldRemoved) &&
					inside.files.every((file) => removed.has(file) && atBefore(file));
				if (ready) emptied.push(path);
			}
			if (!ready) {
				third.push(path);
				continue;
			}
			const bytes = await readBlob(access, target);
			writes.push({
				kind: 'overwrite',
				path,
				bytes,
				sha256: await hashBytes(bytes),
			});
		}
		// The index was given a valid file before admission and is only ever
		// replaced whole, so empty or unparseable bytes are a third state.
		const index = await readPrivateFile(root, 'index');
		const matches = async (head: string | undefined) => {
			if (index === undefined || index.byteLength === 0) return false;
			try {
				return await capturedIndexMatchesHead(access, { head, bytes: index });
			} catch {
				return false;
			}
		};
		const indexDone = await matches(pending.nextHead);
		if (!indexDone && !(await matches(pending.expectedHead)))
			third.push(indexPath);
		return {
			changed,
			removals,
			writes,
			third,
			indexDone,
			leaving: removed,
			emptied,
		};
	}

	/** What still differs from the published commit, with fresh reads. */
	async function unfinished(pending: RecordedIncoming): Promise<string[]> {
		const access: ObjectAccess = {
			fs: createOpfsGitSession(root).fs,
			gitdir: GITDIR,
			cache: {},
		};
		const now = await assess(pending, access);
		const left = [
			...now.third,
			...[...now.removals, ...now.writes]
				.map((change) => stepOf(change))
				.map((step) => (step as { path: string }).path),
		];
		if (!now.indexDone && !left.includes(indexPath)) left.push(indexPath);
		const head = await readRef(branchKey);
		if (head !== pending.nextHead) left.push(branchPath);
		return left;
	}

	/**
	 * Apply removals (pruning what they empty), then remove the `emptied`
	 * directories where writes go, then the writes. Reports what landed and,
	 * when a step's outcome is unknown, that step's path.
	 */
	async function applyInOrder(
		removals: readonly FileChange[],
		emptied: readonly string[],
		writes: readonly FileChange[],
	): Promise<
		| { readonly status: 'applied'; readonly applied: readonly FileStep[] }
		| {
				readonly status: 'failed';
				readonly applied: readonly FileStep[];
				readonly error: FileError;
				readonly unknown: string | undefined;
		  }
	> {
		const applied: FileStep[] = [];
		for (const group of [removals, writes]) {
			if (group === writes) {
				const error = await removeEmptied(emptied);
				if (error !== undefined)
					return { status: 'failed', applied, error, unknown: undefined };
			}
			if (group.length === 0) continue;
			const { error: applyError } = await applyChanges(root, group, landed, {
				prune: true,
			});
			if (applyError === null) {
				applied.push(...group.map(stepOf));
				continue;
			}
			if (applyError.name === 'Partial') {
				applied.push(...applyError.applied);
				const failed = applyError.failed;
				return {
					status: 'failed',
					applied,
					error: applyError.error,
					unknown:
						applyError.error.name === 'Unconfirmed' && failed.kind !== 'move'
							? failed.path
							: undefined,
				};
			}
			return {
				status: 'failed',
				applied,
				error: applyError,
				unknown:
					applyError.name === 'Unconfirmed' ? applyError.path : undefined,
			};
		}
		return { status: 'applied', applied };
	}

	async function recover(): Promise<RecoverIncomingResult> {
		const pending = await readRecord();
		if (pending === undefined) return { status: 'none' };
		if (pending.state === 'unadmitted') {
			// Its stream never closed, so no authored step ever began.
			await clearRecord();
			return { status: 'admissionCleared' };
		}
		if (pending.state === 'unreadable')
			return {
				status: 'refused',
				pending,
				paths: [recordPath],
				reason: `${recordPath} ${pending.reason}`,
			};
		if (pending.branch !== branch)
			return {
				status: 'refused',
				pending,
				paths: [recordPath],
				reason: `the record names the branch '${pending.branch}', and this folder records '${branch}'`,
			};
		const head = await readRef(branchKey);
		// The branch moves last, so naming the published commit means the
		// publication completed. Only the record is left; files are not
		// rewritten, and their state is observed afresh, not assumed clean.
		if (head === pending.nextHead) {
			await clearRecord();
			return { status: 'cleared', pending };
		}
		if (head !== pending.expectedHead)
			return {
				status: 'refused',
				pending,
				paths: [branchPath],
				reason: `the branch names ${head ?? 'no commit'}, which is neither the commit the update was admitted over nor the one it publishes`,
			};
		const session = createOpfsGitSession(root);
		const access: ObjectAccess = { fs: session.fs, gitdir: GITDIR, cache: {} };
		const assessed = await assess(pending, access);
		if (assessed.third.length > 0)
			return {
				status: 'refused',
				pending,
				paths: assessed.third,
				reason: `${assessed.third.join(', ')} ${assessed.third.length === 1 ? 'holds' : 'hold'} neither the update's before nor its after state`,
			};
		const applied = await applyInOrder(
			assessed.removals,
			assessed.emptied,
			assessed.writes,
		);
		if (applied.status === 'failed')
			return applied.unknown === undefined
				? {
						status: 'partial',
						pending,
						applied: applied.applied,
						error: applied.error,
					}
				: {
						status: 'unconfirmed',
						pending,
						applied: applied.applied,
						uncertain: [applied.unknown],
						error: applied.error.message,
					};
		const unknown = (error: unknown, uncertain: string) => {
			if (!(error instanceof UnconfirmedWrite)) throw error;
			return {
				status: 'unconfirmed' as const,
				pending,
				applied: applied.applied,
				uncertain: [uncertain],
				error: error.message,
			};
		};
		if (!assessed.indexDone) {
			await indexTo(
				session.fs,
				pending.nextHead,
				assessed.changed,
				assessed.leaving,
			);
			const target = session.unflushedIndex();
			if (target !== undefined)
				try {
					await writePrivateFile(root, 'index', target);
				} catch (error) {
					return unknown(error, indexPath);
				}
		}
		try {
			await writeRef(branchKey, pending.nextHead);
		} catch (error) {
			return unknown(error, branchPath);
		}
		const left = await unfinished(pending);
		if (left.length > 0)
			return {
				status: 'unconfirmed',
				pending,
				applied: applied.applied,
				uncertain: left,
				error: `${left.join(', ')} did not read back as the update's after state`,
			};
		await clearRecord();
		return { status: 'completed', pending, changedPaths: assessed.changed };
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
		pending: readRecord,
		recover: () => holding(locks, filesLock, recover),
		publishIncoming(plan, prepared) {
			return holding(locks, filesLock, () => publish(plan, prepared));
		},
	};

	/** Under the Git lock and the files lock: admit, record, files, index, branch. */
	async function publish(
		plan: IncomingPlan,
		prepared: OpfsGitSession,
	): Promise<PublishResult> {
		const path = plan.paths[0] ?? '';
		const refused = (operation: string, cause: unknown): PublishResult => ({
			status: 'refused',
			error: FileError.Io({ path, operation, cause }).error,
		});
		// Admission: no record is in the way, and the folder is still exactly
		// what the clean check found. Every portable file has its captured
		// hash, nothing new appeared, the index is the bytes shown to match the
		// admitted head, and the branch still names it. Ordinary saves wait on
		// the files lock held here.
		if ((await readPrivateFile(root, INCOMING_RECORD)) !== undefined)
			return refused(
				'start an incoming update',
				new Error('an incoming update record is already present'),
			);
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
		const index = await readPrivate(INDEX);
		if (!sameBytes(index, plan.baseline.index))
			return { status: 'indexChanged' };
		const head = await readRef(branchKey);
		if (head !== plan.expectedHead)
			return { status: 'branchMoved', actual: head, filesApplied: false };
		const pending: RecordedIncoming = {
			state: 'recorded',
			operationId: crypto.randomUUID(),
			branch,
			expectedHead: plan.expectedHead,
			nextHead: plan.nextHead,
		};
		// Captured files are portable files only. Where a file is to be
		// written, a directory the update does not empty, or a file in one that
		// no path can name, is in the way: refuse before anything is recorded,
		// as recovery would refuse it afterward.
		const admitted = await assess(pending, {
			fs: prepared.fs,
			gitdir: GITDIR,
			cache: {},
		});
		const blocked = admitted.third.find((third) => third !== indexPath);
		if (blocked !== undefined)
			return {
				status: 'refused',
				error: ((await lookup(root, blocked)).kind === 'directory'
					? FileError.NotAFile({ path: blocked })
					: FileError.Exists({ path: blocked })
				).error,
			};

		// From here a failure before the record closed changed no authored file.
		try {
			// The index step later replaces an existing file whole, so its before
			// state is always a readable index.
			if (index === undefined)
				await writePrivateFile(root, 'index', await emptyIndex());
			if (plan.expectedHead !== undefined)
				await writeRef(`${GITDIR}/${PIN_EXPECTED}`, plan.expectedHead);
			await writeRef(`${GITDIR}/${PIN_NEXT}`, plan.nextHead);
		} catch (cause) {
			return refused('prepare the incoming update', cause);
		}
		try {
			await writePrivateFile(
				root,
				INCOMING_RECORD,
				encoder.encode(JSON.stringify(storedRecord(pending))),
			);
		} catch (cause) {
			// A record that may be there holds the folder until it is recovered:
			// empty, it says admission never finished; whole, it is the record.
			if (cause instanceof UnconfirmedWrite)
				return {
					status: 'unconfirmed',
					applied: [],
					uncertain: [recordPath],
					error: cause.message,
				};
			return refused('record the incoming update', cause);
		}

		const applied = await applyInOrder(
			plan.changes.filter((change) => change.kind === 'remove'),
			admitted.emptied,
			plan.changes.filter((change) => change.kind !== 'remove'),
		);
		if (applied.status === 'failed') {
			if (applied.unknown !== undefined)
				return {
					status: 'unconfirmed',
					applied: applied.applied,
					uncertain: [applied.unknown],
					error: applied.error.message,
				};
			if (applied.applied.length > 0)
				return {
					status: 'partial',
					applied: applied.applied,
					error: applied.error,
				};
			// No authored step landed, and none is unknown: the update is
			// refused as if never begun.
			const cleared = await clearRecord().then(
				() => true,
				() => false,
			);
			if (cleared) return { status: 'refused', error: applied.error };
			return { status: 'partial', applied: [], error: applied.error };
		}
		const steps = applied.applied;
		const unknown = (cause: unknown, uncertain: string): PublishResult => ({
			status: 'unconfirmed',
			applied: steps,
			uncertain: [uncertain],
			error: describe(cause),
		});
		try {
			const target = prepared.unflushedIndex();
			if (target !== undefined) await writePrivateFile(root, 'index', target);
		} catch (cause) {
			if (cause instanceof UnconfirmedWrite) return unknown(cause, indexPath);
			return { status: 'indexFailed', error: describe(cause) };
		}
		// The last step: the branch.
		const last = { path: branchPath, operation: 'move the branch' };
		try {
			const moved = await readRef(branchKey);
			if (moved !== plan.expectedHead)
				return { status: 'branchMoved', actual: moved, filesApplied: true };
			await writeRef(branchKey, plan.nextHead);
		} catch (cause) {
			if (cause instanceof UnconfirmedWrite) return unknown(cause, last.path);
			return {
				status: 'partial',
				applied: steps,
				error: FileError.Io({ ...last, cause }).error,
			};
		}
		const left = await unfinished(pending);
		if (left.length > 0)
			return {
				status: 'unconfirmed',
				applied: steps,
				uncertain: left,
				error: `${left.join(', ')} did not read back as the published commit`,
			};
		// The update is complete. A record that will not go away is cleared by
		// an explicit recovery, which finds the branch at the published commit.
		await clearRecord().catch(() => {});
		return { status: 'published' };
	}
}
