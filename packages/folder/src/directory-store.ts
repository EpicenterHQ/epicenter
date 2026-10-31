/**
 * A directory folder's storage, over its host's file system calls
 * (`directory-primitives.ts`): `node:fs` in Bun. The desktop shell's
 * `storage.rs` matches it.
 *
 * Every change lands whole and checked where it lands. A file's bytes are
 * written to a staged file beside the path,
 * `.<scratch name>.epicenter-pending` (`pendingName`), and renamed over the
 * path, carrying what the change expects there (`Expectation`), which the
 * host checks right before the rename, and keeping the mode of a file it
 * replaces: another program sees the old file or the new one, never part
 * of either, and never an empty file first. The rename stays in one
 * directory, so it is one step even where another file system is mounted
 * inside the folder. A new file is placed by a hard link where the disk has
 * them (`directory-node.ts`), so of two writers creating one path exactly
 * one lands. Otherwise no lock spans the check and the rename, so a save
 * another program lands in that instant can be replaced; Git history keeps
 * what sync committed (ADR-0568). A removal carries its expectation too. A
 * host that refuses one changed nothing, and the change is `stale`; any
 * other failure of a rename or a removal may have landed, and is
 * `Unconfirmed`. A put makes a new file's missing parent directories before
 * it stages, and one that does not land removes its staged file, then the
 * parent directories it made, unless another writer put something in one.
 * Each staged file is private to this account before its first byte, so no
 * other account reads a save that has not landed, or one a crash stopped,
 * but for the moment on macOS before an access control entry its directory
 * passed on is removed (`directory-node.ts`).
 *
 * Paths are literal. A symbolic link is never followed: a path through one
 * is unusable. On a case-insensitive disk `plan.md` can reach `Plan.md`;
 * a path whose stored name differs reads as absent, and a write refuses to
 * land on the other file.
 *
 * `.git` at the root is private Git state, which only `git` changes, and no
 * listing shows it. Every other file is listed, hidden and unfinished ones
 * included; a reader leaves out what is not the folder's data.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type Expectation,
	type FileRead,
	type FolderStorage,
	isStaleScratch,
	PRIVATE_DIRECTORY,
	type PutOutcome,
	pendingName,
	scratchName,
	unfinishedName,
} from './boundary.js';
import type { DirectoryPrimitives, EntryKind } from './directory-primitives.js';
import { FileError, UnexpectedTarget } from './errors.js';
import { hashBytes } from './hash.js';
import { pathProblem, readablePath, writableExistingPath } from './paths.js';

/** The directory holding the absolute `path`, which uses `/`. */
const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'));

/** What a literal folder path names on disk. */
type Found =
	| { readonly kind: 'file' | 'directory' | 'other' }
	| { readonly kind: 'absent' }
	/** A case-variant of one of its names is stored there instead. */
	| { readonly kind: 'occupied' }
	/** The path passes through a symbolic link, which is never followed. */
	| { readonly kind: 'link' }
	/** `ancestor` is not a directory, so nothing can be below it. */
	| { readonly kind: 'underFile'; readonly ancestor: string };

const linkRefusal = (path: string) =>
	FileError.InvalidPath({
		path,
		reason: 'the path passes through a symbolic link',
	});

/**
 * The storage of the directory at absolute path `root`, written with `/`,
 * changing files through `primitives`.
 */
export function createDirectoryStorage({
	root,
	primitives: files,
}: {
	root: string;
	primitives: DirectoryPrimitives;
}): FolderStorage {
	const absolute = (path: string) => (path === '' ? root : `${root}/${path}`);

	/** Whether `name` is stored in `parent` under exactly that name. */
	async function literal(
		parent: string,
		name: string,
		found: { readonly kind: EntryKind; readonly name?: string },
	) {
		if (found.kind === 'link' || found.kind === 'other') return true;
		if (found.name !== undefined) return found.name === name;
		return (await files.readDir(parent)).some((entry) => entry.name === name);
	}

	async function find(path: string): Promise<Found> {
		if (path === '') return { kind: 'directory' };
		const segments = path.split('/');
		let at = root;
		for (let index = 0; index < segments.length; index++) {
			const name = segments[index]!;
			const next = `${at}/${name}`;
			const found = await files.lstat(next);
			if (found === undefined) return { kind: 'absent' };
			if (found.kind === 'link') return { kind: 'link' };
			// A name stored under another spelling, on a case-insensitive
			// disk, is another entry: nothing reads through it, and nothing
			// is written into it.
			if (!(await literal(at, name, found))) return { kind: 'occupied' };
			if (index === segments.length - 1) return { kind: found.kind };
			if (found.kind !== 'directory')
				return {
					kind: 'underFile',
					ancestor: segments.slice(0, index + 1).join('/'),
				};
			at = next;
		}
		return { kind: 'absent' };
	}

	async function readOne(path: string): Promise<Result<FileRead, FileError>> {
		try {
			const found = await find(path);
			if (found.kind === 'link') return linkRefusal(path);
			if (found.kind === 'directory') return FileError.NotAFile({ path });
			if (found.kind === 'other')
				return FileError.InvalidPath({
					path,
					reason: 'it is not a regular file and is not followed',
				});
			if (found.kind !== 'file') return FileError.NotFound({ path });
			const { bytes, stamp } = await files.readStamped(absolute(path));
			return Ok({ bytes, stamp, sha256: await hashBytes(bytes) });
		} catch (cause) {
			if (
				(await files.lstat(absolute(path)).catch(() => undefined)) === undefined
			)
				return FileError.NotFound({ path });
			return FileError.Io({ path, operation: 'read', cause });
		}
	}

	/** Where a change to `path` may land, or why it cannot. */
	async function landing(path: string): Promise<Result<Found, FileError>> {
		const found = await find(path);
		if (found.kind === 'link') return linkRefusal(path);
		if (found.kind === 'directory') return FileError.NotAFile({ path });
		if (found.kind === 'occupied' || found.kind === 'other')
			return FileError.InvalidPath({
				path,
				reason: 'another entry occupies this name',
			});
		return Ok(found);
	}

	async function change(
		path: string,
		bytes: Uint8Array | null,
		expected: Expectation,
	): Promise<Result<PutOutcome, FileError>> {
		const { data: found, error } = await landing(path);
		if (error !== null) return Err(error);
		if (bytes === null) {
			if (found.kind !== 'file')
				return Ok(
					expected === 'absent' || expected === 'any'
						? { kind: 'landed', stamp: null }
						: { kind: 'stale' },
				);
			if (expected === 'absent') return Ok({ kind: 'stale' });
			try {
				await files.remove(absolute(path), { expected });
			} catch (cause) {
				if (cause instanceof UnexpectedTarget) return Ok({ kind: 'stale' });
				return FileError.Unconfirmed({ path, operation: 'remove', cause });
			}
			return Ok({ kind: 'landed', stamp: null });
		}
		if (found.kind === 'underFile')
			return FileError.NotADirectory({ path: found.ancestor });
		const scratch = `${parentOf(absolute(path))}/${pendingName(scratchName())}`;
		/** The parent directories this put made, shallowest first. */
		const made: string[] = [];
		/** Remove what this put left: its staged file and the directories it made. */
		async function abandon() {
			await files.remove(scratch).catch(() => {});
			for (const directory of made.toReversed()) {
				// One another writer put something in stays, with those above it.
				const removed = await files.remove(directory).then(
					() => true,
					() => false,
				);
				if (!removed) return;
			}
		}
		try {
			if (found.kind === 'absent') {
				let at = root;
				for (const name of path.split('/').slice(0, -1)) {
					at = `${at}/${name}`;
					if ((await files.lstat(at)) !== undefined) continue;
					await files.mkdir(at);
					made.push(at);
				}
			}
			await files.writeFile(scratch, bytes, {
				createNew: true,
				private: true,
			});
		} catch (cause) {
			await abandon();
			return FileError.Io({ path, operation: 'write', cause });
		}
		let stamp: string;
		try {
			stamp = await files.rename(scratch, absolute(path), expected);
		} catch (cause) {
			await abandon();
			if (cause instanceof UnexpectedTarget) return Ok({ kind: 'stale' });
			return FileError.Unconfirmed({ path, operation: 'write', cause });
		}
		return Ok({ kind: 'landed', stamp });
	}

	return {
		async list() {
			const entries: { path: string; stamp: string }[] = [];
			async function visit(directory: string, prefix: string) {
				for (const entry of await files.readDir(directory)) {
					if (prefix === '' && entry.name === PRIVATE_DIRECTORY) continue;
					const path = prefix + entry.name;
					const at = `${directory}/${entry.name}`;
					if (entry.kind === 'directory') {
						await visit(at, `${path}/`);
						continue;
					}
					const found = await files.lstat(at);
					if (found !== undefined) entries.push({ path, stamp: found.stamp });
				}
			}
			try {
				await visit(root, '');
			} catch (cause) {
				return FileError.Io({ path: '', operation: 'list', cause });
			}
			return Ok(entries.sort((a, b) => (a.path < b.path ? -1 : 1)));
		},
		async read(path) {
			return readablePath(path)
				? readOne(path)
				: FileError.InvalidPath({
						path,
						reason: 'the path cannot be read safely',
					});
		},
		async put(path, bytes, expected) {
			const problem = pathProblem(path);
			const refused =
				problem === undefined
					? undefined
					: FileError.InvalidPath({ path, reason: problem });
			// An existing nonportable name may be replaced or removed, never made.
			if (
				refused &&
				(!writableExistingPath(path) ||
					(bytes !== null && expected === 'absent'))
			)
				return refused;
			const checked =
				refused && bytes !== null && expected === 'any' ? 'present' : expected;
			const owned = bytes === null ? null : new Uint8Array(bytes);
			let result: Result<PutOutcome, FileError>;
			try {
				result = await change(path, owned, checked);
			} catch (cause) {
				result = FileError.Io({ path, operation: 'write', cause });
			}
			// The nonportable file went before this write landed, which cannot make it.
			if (refused && checked !== expected && result.data?.kind === 'stale')
				return refused;
			return result;
		},
	};
}

/**
 * Remove the files a stopped write (a crash, a quit) staged anywhere below
 * the directory at `root` an hour or more ago: regular files named
 * `.<scratch name>.epicenter-pending` (`pendingName`, `isStaleScratch`), in
 * one walk that follows no link and never enters `.git`. Another handle or
 * process may be writing the directory now, so younger ones stay, and so
 * does every other file: a recording in progress never has a scratch name.
 * What cannot be read or removed stays; it is inert, and an open that
 * cannot clear it still opens. The desktop shell sweeps its own at each
 * grant (`sweep_scratch`).
 */
export async function sweepStaleScratch(
	root: string,
	files: DirectoryPrimitives,
): Promise<void> {
	const now = Date.now();
	async function visit(directory: string) {
		const entries = await files.readDir(directory).catch(() => []);
		for (const entry of entries) {
			const at = `${directory}/${entry.name}`;
			if (entry.kind === 'directory') {
				if (entry.name.toLowerCase() !== PRIVATE_DIRECTORY) await visit(at);
				continue;
			}
			const scratch = unfinishedName(entry.name);
			if (
				entry.kind === 'file' &&
				scratch !== undefined &&
				isStaleScratch(scratch, now)
			)
				await files.remove(at).catch(() => {});
		}
	}
	await visit(root);
}
