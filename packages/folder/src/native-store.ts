/**
 * Ordinary files in a native folder.
 *
 * Current files are the source. A conditional write hashes the current bytes
 * and replaces them only when they match; this is a best-effort check, not an
 * operating-system-wide compare-and-swap against other programs. Exclusive
 * creation and moves use hard links, which fail rather than overwrite an
 * existing destination. A write stages its bytes in a scratch file under
 * `.git/epicenter/scratch` first.
 *
 * A replacement checks again that a file is at the path (with the expected
 * sha256, when one is given), then exchanges the scratch file with it in one
 * system call (`native-exchange.ts`). The exchange requires the file to exist
 * at that moment, so a replacement never puts back a file another program
 * removed, however late the removal: the outcome is `NotFound`, or
 * `Conflict` when a sha256 was expected. Bytes another program wrote between
 * the second check and the exchange are still displaced. macOS and Linux
 * exchange; a filesystem there that cannot, or an addon that is not built,
 * is an `Io` failure and nothing is written. An overwrite renames on every
 * platform; it may create the file, and is a separate guarantee.
 *
 * The exchange is the only operation on the path. What it displaced lands in
 * scratch: a regular file is removed. Anything else (a directory, a link, a
 * pipe, or an entry that cannot be inspected) is kept where it is, and the
 * outcome is a `Partial` whose write is both applied and failed, with an `Io`
 * error naming where the entry was kept. Nothing tries to put it back: by
 * then the path may hold a third program's bytes.
 *
 * Windows has no exchange here yet, so a replacement is unavailable there
 * until a mechanism that requires the file at publication is proven: it is
 * an `Io` failure naming the platform, the staged copy is removed, and the
 * file at the path is untouched. Nothing retries it. Creation, reads,
 * overwrites, moves, and removals are unchanged by this repair; none is
 * verified on Windows.
 *
 * One boundary applies its batches one at a time, so two saves through the
 * same opened folder never share that window: the later one checks against
 * what the earlier one left. A capture's enumeration and reads take the same
 * turn, so it never sees one of this boundary's batches half applied. This
 * orders this boundary's own batches and captures only. It is
 * not a file lock, and another program or a second boundary on the same
 * directory still races as described above. Other reads are not ordered.
 *
 * A multi-file batch applies ordered steps. When a step fails, the result
 * reports which steps reached the folder; nothing is rolled back.
 */
import { constants, type Stats } from 'node:fs';
import {
	link,
	lstat,
	mkdir,
	open,
	readdir,
	realpath,
	rename,
	rmdir,
	unlink,
	writeFile,
} from 'node:fs/promises';
import { join, sep } from 'node:path';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type {
	CapturedFiles,
	FileBoundary,
	FileChange,
	FileListing,
	FileRead,
} from './boundary.js';
import { hashBytes } from './capture.js';
import { ApplyError, describe, FileError, type FileStep } from './errors.js';
import { exchangeFiles } from './native-exchange.js';
import { ancestors, isPortablePath, pathProblem } from './paths.js';

type Code = { code?: string };
const codeOf = (cause: unknown) => (cause as Code | undefined)?.code;

/** What a directory entry that is not a regular file is, for a message. */
function entryKind(stats: Stats): string {
	if (stats.isDirectory()) return 'a directory';
	if (stats.isSymbolicLink()) return 'a symbolic link';
	if (stats.isFIFO()) return 'a named pipe';
	if (stats.isSocket()) return 'a socket';
	return 'a special file';
}

/**
 * Open without following a final symbolic link and without waiting for a
 * pipe's writer. Windows has neither flag, and opens as usual.
 */
const UNFOLLOWED =
	constants.O_RDONLY |
	(constants.O_NOFOLLOW ?? 0) |
	(constants.O_NONBLOCK ?? 0);

/**
 * The bytes of the regular file at `absolute`, or what is there instead.
 * Another program may have replaced the file since it was inspected: a link
 * is not followed, and a pipe or device is not read, since a read of one
 * could wait forever. Absence and other failures throw, as `readFile` does.
 */
async function readRegular(
	absolute: string,
): Promise<Uint8Array | 'link' | 'special'> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(absolute, UNFOLLOWED);
	} catch (cause) {
		if (codeOf(cause) === 'ELOOP') return 'link';
		throw cause;
	}
	try {
		if (!(await handle.stat()).isFile()) return 'special';
		return new Uint8Array(await handle.readFile());
	} finally {
		await handle.close();
	}
}

/** How a listing spells a name: UTF-8, with each invalid sequence as U+FFFD. */
const lossy = new TextDecoder();
const strict = new TextDecoder('utf-8', { fatal: true });

function isUtf8(bytes: Uint8Array): boolean {
	try {
		strict.decode(bytes);
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether `directory` holds an entry whose name is not UTF-8 and which a
 * listing spells `name`. That spelling names no file, so a read of it is
 * refused rather than reported absent.
 */
async function holdsUndecodable(
	directory: string,
	name: string,
): Promise<boolean> {
	if (!name.includes('\uFFFD')) return false;
	const raw = await readdir(directory, { encoding: 'buffer' }).catch(() => []);
	return raw.some((bytes) => !isUtf8(bytes) && lossy.decode(bytes) === name);
}

export function createNativeFileBoundary(root: string): FileBoundary {
	const scratch = join(root, '.git', 'epicenter', 'scratch');
	const absolute = (path: string) => join(root, ...path.split('/'));

	function invalid(path: string): Result<never, FileError> | undefined {
		const problem = pathProblem(path);
		return problem === undefined
			? undefined
			: FileError.InvalidPath({ path, reason: problem });
	}

	/**
	 * Verify each component's literal spelling and that nothing on the way is
	 * a symbolic link, so a case-insensitive filesystem cannot alias another
	 * name and a link cannot escape the folder.
	 */
	async function verifyLiteral(
		path: string,
	): Promise<Result<'file' | 'directory' | 'absent', FileError>> {
		const parts = path.split('/');
		let directory = root;
		for (let index = 0; index < parts.length; index++) {
			const name = parts[index]!;
			let names: string[];
			try {
				names = await readdir(directory);
			} catch (cause) {
				if (codeOf(cause) === 'ENOENT') return Ok('absent');
				if (codeOf(cause) === 'ENOTDIR')
					return FileError.NotADirectory({
						path: parts.slice(0, index).join('/'),
					});
				return FileError.Io({
					path,
					operation: 'list the directory of',
					cause,
				});
			}
			if (!names.includes(name)) return Ok('absent');
			const next = join(directory, name);
			let stats: Awaited<ReturnType<typeof lstat>>;
			try {
				stats = await lstat(next);
			} catch (cause) {
				if (codeOf(cause) !== 'ENOENT')
					return FileError.Io({ path, operation: 'inspect', cause });
				if (await holdsUndecodable(directory, name))
					return FileError.InvalidPath({
						path,
						reason: 'the name on disk is not UTF-8, so no folder path names it',
					});
				return Ok('absent');
			}
			if (stats.isSymbolicLink())
				return FileError.InvalidPath({
					path,
					reason: 'the path passes through a symbolic link',
				});
			const last = index === parts.length - 1;
			if (last) {
				if (stats.isDirectory()) return Ok('directory');
				if (stats.isFile()) return Ok('file');
				// A device, socket, or pipe: reading it could block forever.
				return FileError.InvalidPath({
					path,
					reason: 'the path is not a regular file',
				});
			}
			if (!stats.isDirectory())
				return FileError.NotADirectory({
					path: parts.slice(0, index + 1).join('/'),
				});
			directory = next;
		}
		return Ok('absent');
	}

	async function readCurrent(
		path: string,
	): Promise<Result<FileRead | undefined, FileError>> {
		const { data: kind, error: kindError } = await verifyLiteral(path);
		if (kindError !== null) return Err(kindError);
		if (kind === 'absent') return Ok(undefined);
		if (kind === 'directory') return FileError.NotAFile({ path });
		try {
			const bytes = await readRegular(absolute(path));
			if (bytes === 'link')
				return FileError.InvalidPath({
					path,
					reason: 'the path passes through a symbolic link',
				});
			if (bytes === 'special')
				return FileError.InvalidPath({
					path,
					reason: 'the path is not a regular file',
				});
			return Ok({ bytes, sha256: await hashBytes(bytes) });
		} catch (cause) {
			if (codeOf(cause) === 'ENOENT') return Ok(undefined);
			return FileError.Io({ path, operation: 'read', cause });
		}
	}

	async function ensureParent(
		path: string,
	): Promise<Result<undefined, FileError>> {
		for (const parent of ancestors(path)) {
			const { data: kind, error: kindError } = await verifyLiteral(parent);
			if (kindError !== null) return Err(kindError);
			if (kind === 'file') return FileError.NotADirectory({ path: parent });
			if (kind === 'absent') {
				try {
					await mkdir(absolute(parent));
				} catch (cause) {
					if (codeOf(cause) !== 'EEXIST')
						return FileError.Io({ path: parent, operation: 'create', cause });
				}
			}
		}
		return Ok(undefined);
	}

	async function scratchFile(bytes: Uint8Array): Promise<string> {
		await mkdir(scratch, { recursive: true });
		const file = join(
			scratch,
			`${Date.now().toString(36)}-${crypto.randomUUID()}`,
		);
		await writeFile(file, bytes, { flag: 'wx' });
		return file;
	}

	function conflict(
		path: string,
		expectedSha256: string,
		actualSha256: string | undefined,
	) {
		return FileError.Conflict({ path, expectedSha256, actualSha256 });
	}

	/**
	 * A replacement needs a file at the path, guarded or not; with a baseline
	 * the file's bytes must also hash to it.
	 */
	function replaceable(
		path: string,
		expectedSha256: string | undefined,
		current: { sha256: string } | undefined,
	) {
		if (expectedSha256 !== undefined) {
			if (current?.sha256 !== expectedSha256)
				return conflict(path, expectedSha256, current?.sha256);
			return undefined;
		}
		if (current === undefined) return FileError.NotFound({ path });
		return undefined;
	}

	/**
	 * Put the staged bytes at `path` only if a file is there when they land,
	 * and settle `temporary`. Until the one exchange succeeds it holds the
	 * staged bytes, removed on any failure. After it the write has landed and
	 * `temporary` holds whatever the path held: a regular file is removed;
	 * anything else, or an entry that cannot be inspected, stays exactly
	 * there, `landed` receives the write, and the `Io` error names where it
	 * is. Nothing touches the path again: another program may already have
	 * written there since.
	 */
	async function publishReplacement(
		path: string,
		expectedSha256: string | undefined,
		temporary: string,
		landed: FileStep[],
	): Promise<Result<undefined, FileError>> {
		const target = absolute(path);
		const discard = () => unlink(temporary).catch(() => {});
		// Every platform publishes a replacement this way and no other. Where
		// there is no exchange, Windows included, it rejects without a `code`
		// before touching the path: `Io`, nothing written.
		try {
			await exchangeFiles(temporary, target);
		} catch (cause) {
			// Nothing was exchanged: `temporary` holds only the staged bytes.
			const missing = codeOf(cause) === 'ENOENT';
			const staged =
				missing &&
				(await lstat(temporary).then(
					() => true,
					() => false,
				));
			await discard();
			if (!missing) return FileError.Io({ path, operation: 'replace', cause });
			// Either path may be the missing one; the staged file never moves.
			if (!staged)
				return FileError.Io({ path, operation: 'stage bytes for', cause });
			return expectedSha256 === undefined
				? FileError.NotFound({ path })
				: conflict(path, expectedSha256, undefined);
		}
		let displaced: Stats | undefined;
		let unreadable: unknown;
		try {
			displaced = await lstat(temporary);
		} catch (cause) {
			unreadable = cause;
		}
		if (displaced?.isFile()) {
			await discard();
			return Ok(undefined);
		}
		landed.push({ kind: 'write', path });
		const found =
			displaced === undefined
				? `could not be inspected (${describe(unreadable)})`
				: `is ${entryKind(displaced)}, not a regular file`;
		return FileError.Io({
			path,
			operation: 'set aside what the replacement displaced from',
			cause: new Error(
				`The new bytes landed at '${path}', so the file there changed. What they displaced ${found}, and it was left at '${temporary}'. Inspect '${path}', and anything written there since, before restoring it.`,
				{ cause: unreadable },
			),
		});
	}

	/**
	 * Apply one change. A step that fails after something of it landed puts
	 * that in `landed`, so the caller reports it instead of an ordinary error:
	 * a move whose destination link landed but whose source was not retired,
	 * and a replacement whose bytes landed but whose displaced entry was kept.
	 */
	async function step(
		change: FileChange,
		landed: FileStep[],
	): Promise<Result<undefined, FileError>> {
		if (
			change.kind === 'create' ||
			change.kind === 'replace' ||
			change.kind === 'overwrite'
		) {
			const { data: current, error: readError } = await readCurrent(
				change.path,
			);
			if (readError !== null) return Err(readError);
			if (change.kind === 'create' && current !== undefined)
				return FileError.Exists({ path: change.path });
			if (change.kind === 'replace') {
				const refused = replaceable(
					change.path,
					change.expectedSha256,
					current,
				);
				if (refused !== undefined) return refused;
			}
			// A replacement's file, and so its parent, was just found; creating a
			// parent that went since would only leave an empty directory behind.
			if (change.kind !== 'replace') {
				const parent = await ensureParent(change.path);
				if (parent.error !== null) return parent;
			}
			let temporary: string;
			try {
				temporary = await scratchFile(change.bytes);
			} catch (cause) {
				return FileError.Io({
					path: change.path,
					operation: 'stage bytes for',
					cause,
				});
			}
			// Whether `temporary` is still only the staged bytes, for the cleanup below.
			let staged = true;
			try {
				if (change.kind === 'replace') {
					// Staging took time. Check the sha256 again so the only unchecked
					// window left is this read to the exchange.
					const { data: now, error: rereadError } = await readCurrent(
						change.path,
					);
					if (rereadError !== null) return Err(rereadError);
					const refused = replaceable(change.path, change.expectedSha256, now);
					if (refused !== undefined) return refused;
					staged = false;
					const published = await publishReplacement(
						change.path,
						change.expectedSha256,
						temporary,
						landed,
					);
					if (published.error !== null) return published;
				} else if (change.kind === 'create') {
					// Exclusive creation: link fails instead of replacing a newcomer.
					try {
						await link(temporary, absolute(change.path));
					} catch (cause) {
						if (codeOf(cause) === 'EEXIST') {
							return FileError.Exists({ path: change.path });
						}
						return FileError.Io({
							path: change.path,
							operation: 'create',
							cause,
						});
					}
				} else {
					// A deliberate overwrite: create or replace, whatever is there.
					try {
						await rename(temporary, absolute(change.path));
					} catch (cause) {
						return FileError.Io({
							path: change.path,
							operation: 'replace',
							cause,
						});
					}
				}
			} finally {
				// The staged bytes, or nothing after a rename. A replacement settles
				// `temporary` itself once it hands it over.
				if (staged) await unlink(temporary).catch(() => {});
			}
			return Ok(undefined);
		}
		if (change.kind === 'remove') {
			const { data: current, error: readError } = await readCurrent(
				change.path,
			);
			if (readError !== null) return Err(readError);
			if (current === undefined)
				return FileError.NotFound({ path: change.path });
			if (
				change.expectedSha256 !== undefined &&
				current.sha256 !== change.expectedSha256
			)
				return conflict(change.path, change.expectedSha256, current.sha256);
			try {
				await unlink(absolute(change.path));
			} catch (cause) {
				if (codeOf(cause) === 'ENOENT')
					return FileError.NotFound({ path: change.path });
				return FileError.Io({ path: change.path, operation: 'remove', cause });
			}
			return Ok(undefined);
		}
		const { data: current, error: readError } = await readCurrent(change.from);
		if (readError !== null) return Err(readError);
		if (current === undefined) return FileError.NotFound({ path: change.from });
		if (
			change.expectedSha256 !== undefined &&
			current.sha256 !== change.expectedSha256
		)
			return conflict(change.from, change.expectedSha256, current.sha256);
		const { data: destination, error: destinationError } = await verifyLiteral(
			change.to,
		);
		if (destinationError !== null) return Err(destinationError);
		if (destination === 'directory')
			return FileError.NotAFile({ path: change.to });
		if (destination === 'file') {
			return FileError.Exists({ path: change.to });
		}
		const parent = await ensureParent(change.to);
		if (parent.error !== null) return parent;
		if (change.expectedSha256 !== undefined) {
			// The destination checks took time; the link must carry the bytes checked.
			const { data: now, error: rereadError } = await readCurrent(change.from);
			if (rereadError !== null) return Err(rereadError);
			if (now?.sha256 !== change.expectedSha256)
				return conflict(change.from, change.expectedSha256, now?.sha256);
		}
		try {
			await link(absolute(change.from), absolute(change.to));
		} catch (cause) {
			if (codeOf(cause) === 'EEXIST') {
				return FileError.Exists({ path: change.to });
			}
			return FileError.Io({ path: change.to, operation: 'move to', cause });
		}
		landed.push({ kind: 'write', path: change.to });
		try {
			await unlink(absolute(change.from));
		} catch (cause) {
			// Both paths now hold the bytes; nothing is rolled back.
			return FileError.Io({ path: change.from, operation: 'retire', cause });
		}
		return Ok(undefined);
	}

	// Batches and captures from this boundary run in arrival order. One that
	// fails or throws releases the next.
	let tail: Promise<unknown> = Promise.resolve();
	function inOrder<T>(work: () => Promise<T>): Promise<T> {
		const result = tail.then(work, work);
		tail = result.catch(() => {});
		return result;
	}

	function toStep(change: FileChange): FileStep {
		return change.kind === 'move'
			? { kind: 'move', from: change.from, to: change.to }
			: {
					kind: change.kind === 'remove' ? 'remove' : 'write',
					path: change.path,
				};
	}

	/**
	 * Walk by the names' bytes, so an entry whose name is not UTF-8 is still
	 * inspected and descended into. It is listed by its lossy spelling, which
	 * a read refuses.
	 */
	async function walk(
		directory: Buffer,
		prefix: string,
		files: { path: string; size: number }[],
		directories: string[],
	) {
		for (const bytes of await readdir(directory, { encoding: 'buffer' })) {
			const name = lossy.decode(bytes);
			const path = prefix === '' ? name : `${prefix}/${name}`;
			if (prefix === '' && name === '.git') continue;
			const entry = Buffer.concat([directory, Buffer.from(sep), bytes]);
			let stats: Stats;
			try {
				stats = await lstat(entry);
			} catch (cause) {
				// Removed since it was named: it is not there to list.
				if (codeOf(cause) === 'ENOENT') continue;
				throw cause;
			}
			if (stats.isDirectory()) {
				directories.push(path);
				await walk(entry, path, files, directories);
			} else {
				// A link or special entry is listed so a read can refuse it; its
				// size is its own, never its target's.
				files.push({ path, size: stats.size });
			}
		}
	}

	async function list(): Promise<Result<FileListing, FileError>> {
		const files: { path: string; size: number }[] = [];
		const directories: string[] = [];
		try {
			await walk(Buffer.from(root), '', files, directories);
		} catch (cause) {
			return FileError.Io({ path: '', operation: 'enumerate', cause });
		}
		files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		const listing: FileListing = { files, directories: directories.sort() };
		return Ok(listing);
	}

	async function children(
		directory: string,
	): Promise<Result<{ files: string[]; directories: string[] }, FileError>> {
		if (directory !== '') {
			const refused = invalid(directory);
			if (refused) return refused;
			const { data: kind, error: kindError } = await verifyLiteral(directory);
			if (kindError !== null) return Err(kindError);
			if (kind === 'absent') return FileError.NotFound({ path: directory });
			if (kind === 'file') return FileError.NotADirectory({ path: directory });
		}
		try {
			const entries = await readdir(
				directory === '' ? root : absolute(directory),
				{ withFileTypes: true },
			);
			const files: string[] = [];
			const directories: string[] = [];
			for (const entry of entries) {
				if (directory === '' && entry.name === '.git') continue;
				// A link or special entry is listed so a read can refuse it.
				(entry.isDirectory() ? directories : files).push(entry.name);
			}
			return Ok({ files: files.sort(), directories: directories.sort() });
		} catch (cause) {
			return FileError.Io({ path: directory, operation: 'list', cause });
		}
	}

	return {
		list,
		children,
		async read(path) {
			const refused = invalid(path);
			if (refused) return refused;
			const { data: current, error: readError } = await readCurrent(path);
			if (readError !== null) return Err(readError);
			if (current === undefined) return FileError.NotFound({ path });
			return Ok(current);
		},
		async readMany(paths) {
			const results = new Map<string, Result<FileRead, FileError>>();
			for (const path of paths) results.set(path, await this.read(path));
			return Ok(results);
		},
		async open(path) {
			// The bytes are copied into memory, so replacing the path later does not
			// change what the consumer receives (ADR-0466).
			const { data: read, error: readError } = await this.read(path);
			if (readError !== null) return Err(readError);
			return Ok(new Blob([read.bytes as Uint8Array<ArrayBuffer>]));
		},
		async apply(changes) {
			for (const change of changes) {
				const paths =
					change.kind === 'move' ? [change.from, change.to] : [change.path];
				for (const path of paths) {
					const refused = invalid(path);
					if (refused) return refused;
				}
			}
			return inOrder(async () => {
				const applied: FileStep[] = [];
				for (let index = 0; index < changes.length; index++) {
					const change = changes[index]!;
					const landed: FileStep[] = [];
					const { error: stepError } = await step(change, landed);
					if (stepError !== null) {
						const reached = [...applied, ...landed];
						// A refusal before anything landed wrote nothing; report it directly.
						if (reached.length === 0) return Err(stepError);
						return ApplyError.Partial({
							applied: reached,
							// A move whose destination landed failed at retiring its source.
							// A replacement whose bytes landed failed at settling what they
							// displaced: its write is both applied and failed.
							failed:
								landed.length > 0 && change.kind === 'move'
									? { kind: 'remove', path: change.from }
									: toStep(change),
							error: stepError,
							notAttempted: changes.slice(index + 1).map(toStep),
						});
					}
					applied.push(toStep(change));
				}
				return Ok(undefined);
			});
		},
		async mkdir(path) {
			const refused = invalid(path);
			if (refused) return refused;
			const parent = await ensureParent(`${path}/x`);
			if (parent.error !== null) return parent;
			return Ok(undefined);
		},
		async rmdir(path) {
			const refused = invalid(path);
			if (refused) return refused;
			const { data: kind, error: kindError } = await verifyLiteral(path);
			if (kindError !== null) return Err(kindError);
			if (kind === 'absent') return FileError.NotFound({ path });
			if (kind === 'file') return FileError.NotADirectory({ path });
			try {
				await rmdir(absolute(path));
				return Ok(undefined);
			} catch (cause) {
				if (codeOf(cause) === 'ENOTEMPTY' || codeOf(cause) === 'EEXIST')
					return FileError.DirectoryNotEmpty({ path });
				return FileError.Io({ path, operation: 'remove directory', cause });
			}
		},
		async capture() {
			// Enumeration and every read share one turn with this boundary's
			// batches. A rename landing between the two would otherwise leave the
			// old path unreadable and the new path never enumerated.
			return inOrder(async () => {
				const { data: listing, error: listError } = await list();
				if (listError !== null) return Err(listError);
				const files = new Map<string, Uint8Array>();
				const unreadable: { path: string; error: FileError }[] = [];
				for (const { path } of listing.files) {
					if (!isPortablePath(path)) continue;
					try {
						const bytes = await readRegular(absolute(path));
						// History holds regular files only: a link or special
						// entry, listed or swapped in since, is left out.
						if (typeof bytes === 'string') continue;
						files.set(path, bytes);
					} catch (cause) {
						// Another program removed it after enumeration: absent from this capture.
						if (codeOf(cause) === 'ENOENT') continue;
						unreadable.push({
							path,
							error: FileError.Io({ path, operation: 'read', cause }).error,
						});
					}
				}
				const captured: CapturedFiles = { files, unreadable };
				return Ok(captured);
			});
		},
	};
}

/** Resolve the folder root once, refusing a path that is not a directory. */
export async function resolveNativeRoot(root: string): Promise<string> {
	const resolved = await realpath(root);
	const stats = await lstat(resolved);
	if (!stats.isDirectory())
		throw new Error(`The native folder root '${root}' is not a directory.`);
	return resolved;
}

/**
 * Refuse a root whose private Git state would send writes somewhere else:
 * `.git` as a symbolic link or a `gitdir:` file (a linked worktree or
 * submodule), and a linked `.git/epicenter` or scratch directory. Scratch
 * files are renamed into the folder, so they must live inside it.
 *
 * This inspects the layout once, when the folder opens. It does not defend
 * against a program that swaps a link in afterward.
 */
export async function verifyNativeLayout(root: string): Promise<void> {
	for (const [relative, label] of [
		['.git', '.git'],
		[join('.git', 'epicenter'), '.git/epicenter'],
		[join('.git', 'epicenter', 'scratch'), '.git/epicenter/scratch'],
	] as const) {
		let stats: Awaited<ReturnType<typeof lstat>>;
		try {
			stats = await lstat(join(root, relative));
		} catch (cause) {
			// Nothing below an absent directory exists yet; opening creates it.
			if (codeOf(cause) === 'ENOENT') return;
			throw cause;
		}
		if (stats.isSymbolicLink())
			throw new Error(
				`The native folder '${root}' cannot be opened: ${label} is a symbolic link.`,
			);
		if (!stats.isDirectory())
			throw new Error(
				relative === '.git'
					? `The native folder '${root}' cannot be opened: .git is a file that points at another Git directory.`
					: `The native folder '${root}' cannot be opened: ${label} is not a directory.`,
			);
	}
}
