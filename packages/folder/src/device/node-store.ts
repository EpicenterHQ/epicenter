/**
 * A device store over a directory, in Bun or Node, over `node:fs`: a plain
 * store that writes as ADR-0702 decides, without the desktop shell's
 * edge-case checks (the folder core's `storage.rs` stays the strict host).
 *
 * - A version is the file's Git blob id (ADR-0808): a note's (and any
 *   hidden file's) hashed from its bytes, an attachment's from its sha256,
 *   kept by its stamp (its size, modification time in nanoseconds, and
 *   inode) in the hash cache the caller names (`hashes`; the Epicenter
 *   folder keeps one per directory, named by its identity), so a listing
 *   reads no recording it hashed before. A write lands only while its path
 *   holds the version its writer expects, checked right before the change,
 *   an attachment hashed again first. Its bytes are staged beside the
 *   target in `.ep-<random>.save` (`saveName`), made exclusively with mode
 *   0600, so another program sees the old file or the new one, never part
 *   of either (ADR-0822). A replacement is renamed over the path, keeping
 *   the replaced file's permission bits. A create is placed by a hard link,
 *   which the file system refuses when anything has the name, so of writers
 *   creating one path, in any process, exactly one lands.
 * - Within this process, writes to one path take turns from the check to the
 *   change (`createPathTurns`): of two writers over one version, one lands
 *   and the other finds it `Moved`. Across processes nothing holds a path between
 *   a replacement's check and its rename; Git history is the backstop.
 * - A path that leaves the directory or names `.git` is refused, and a name
 *   only some disks hold (`pathProblem`) is never made; an existing one is
 *   replaced or removed over its version like any other.
 * - A listing is every regular file below the directories asked for, `.git`
 *   and an older build's `.epicenter` at the root aside, hidden ones
 *   included for its reader to skip (`isHiddenPath`), except a reserved
 *   name (`isReservedName`), which nothing describes. A file or directory
 *   removed while it lists is not listed.
 * - A watch answers once Node's recursive watcher is live (`watchDirectory`).
 *
 * A save a crash stopped leaves its staged file beside its target, hidden,
 * never listed, and safe to delete; a sweep removes it once it is an hour
 * old (`sweepSaves`, and the desktop shell's at each open).
 */
import type { BigIntStats } from 'node:fs';
import {
	chmod,
	link,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ClientError, storedWithLfs } from '@epicenter/definition/contract';
import { Ok } from 'wellcrafted/result';
import { blobIdOf, gitBlobId, sha256Of } from '../hash.js';
import { watchDirectory } from '../native/watch.js';
import { createPathTurns } from '../path-turns.js';
import { pathProblem, readablePath, writableExistingPath } from '../paths.js';
import { isReservedName, LEGACY_DIRECTORY, saveName } from '../state.js';
import { createStampCache, type StampFile } from './stamp-cache.js';
import {
	type BlobId,
	type Listed,
	type Store,
	StoreError,
	within,
} from './store.js';

/** This process's writers to each path, taking turns from the check to the change. */
const turns = createPathTurns();

const codeOf = (cause: unknown) => (cause as { code?: unknown } | null)?.code;

/** A file's stamp: its size, modification time, and identity, which every save changes. */
const stampOf = (stats: BigIntStats) => ({
	stamp: `${stats.size}:${stats.mtimeNs}:${stats.ino}`,
	modifiedMs: Number(stats.mtimeNs / 1_000_000n),
});

/** The version the file at `target` (the folder's `path`) holds now, read and hashed whole; undefined when nothing is there. */
async function versionAt(target: string, path: string) {
	try {
		return await blobIdOf(path, new Uint8Array(await readFile(target)));
	} catch (cause) {
		const code = codeOf(cause);
		if (code === 'ENOENT' || code === 'EISDIR') return undefined;
		throw cause;
	}
}

/**
 * Put `staged` at `target` only while nothing is there: a hard link, which
 * the file system refuses when any entry has the name. Where the disk has no
 * hard links (FAT, exFAT, some network shares), the path is checked, then
 * renamed onto, and a writer in another process racing that check can be
 * replaced.
 *
 * `node:fs` has no exclusive rename, which the desktop shell places with
 * (`storage::place`). A file made here had two names for a moment, so on
 * macOS a watcher is never told when it is deleted before it is saved
 * again: FSEvents does not report removing a file that ever had a second
 * name. This host serves the CLI and scripts, which do not watch for long;
 * `epicenter sync` stages every deletion with the rest of its round.
 */
async function place(staged: string, target: string) {
	try {
		await link(staged, target);
		return 'landed' as const;
	} catch (cause) {
		const code = codeOf(cause);
		if (code === 'EEXIST') return 'stale' as const;
		if (code === 'EXDEV' || code === 'ENOENT') throw cause;
	}
	if ((await lstat(target).catch(() => undefined)) !== undefined)
		return 'stale' as const;
	await rename(staged, target);
	return 'landed' as const;
}

/** Why `path` cannot be written, or undefined when it can. */
function refusal(
	path: string,
	bytes: Uint8Array | null,
	expect: BlobId | null,
) {
	const problem = pathProblem(path);
	if (problem === undefined) return undefined;
	// An existing nonportable name may be replaced or removed, never made.
	if (writableExistingPath(path) && (bytes === null || expect !== null))
		return undefined;
	return `The path '${path}' is not usable: ${problem}`;
}

/** What a write at one path found: the version it landed, or what the path held instead. */
type Landing = { landed: BlobId | null } | { moved: BlobId | null };

/**
 * The hash cache kept in the file at `path`, written through a staged save
 * beside it: what `nodeStore` takes as its `hashes`.
 */
export function stampFileAt(path: string): StampFile {
	return {
		async load() {
			try {
				return new Uint8Array(await readFile(path));
			} catch {
				return null;
			}
		},
		async save(bytes) {
			await mkdir(dirname(path), { recursive: true });
			const staged = join(dirname(path), saveName());
			try {
				await writeFile(staged, bytes, { flag: 'wx', mode: 0o600 });
				await rename(staged, path);
			} finally {
				await rm(staged, { force: true });
			}
		},
	};
}

/**
 * The store of the existing directory at `root`. `hashes` is where it keeps
 * its attachments' hashes between runs; without one it keeps them for the
 * store's life only.
 */
export function nodeStore(
	root: string,
	{ hashes: file = null }: { hashes?: StampFile | null } = {},
): Store {
	const unavailable = (cause: unknown) => ClientError.Unavailable({ cause });
	const hashes = createStampCache({
		file: file ?? { load: async () => null, save: async () => {} },
	});

	/** Land `bytes` at `target` (the folder's `path`) over `expect`, staged beside it. */
	async function save(
		target: string,
		path: string,
		bytes: Uint8Array,
		expect: BlobId | null,
	): Promise<Landing> {
		const staged = join(dirname(target), saveName());
		const landed = await blobIdOf(path, bytes);
		try {
			await mkdir(dirname(target), { recursive: true });
			await writeFile(staged, bytes, { flag: 'wx', mode: 0o600 });
			return await turns.run(target, async (): Promise<Landing> => {
				const now = (await versionAt(target, path)) ?? null;
				if (now !== expect) return { moved: now };
				if (expect !== null) {
					await chmod(staged, (await stat(target)).mode & 0o777);
					await rename(staged, target);
				} else if ((await place(staged, target)) === 'stale')
					return { moved: (await versionAt(target, path)) ?? null };
				return { landed };
			});
		} finally {
			await rm(staged, { force: true });
		}
	}

	/** The file at `at` (the folder's `path`) as a listing names it, or undefined when it is none. */
	async function describe(at: string, path: string) {
		try {
			const stats = await lstat(at, { bigint: true });
			if (!stats.isFile()) return undefined;
			const read = async () => new Uint8Array(await readFile(at));
			const version = storedWithLfs(path)
				? await hashes.version(path, stampOf(stats), async () => {
						const bytes = await read();
						return { oid: await sha256Of(bytes), size: bytes.byteLength };
					})
				: await gitBlobId(await read());
			return { path, version, size: Number(stats.size) } satisfies Listed;
		} catch (cause) {
			if (codeOf(cause) === 'ENOENT') return undefined;
			throw cause;
		}
	}

	/** Every regular file below `directory` (the folder's `prefix`), into `files`. */
	async function visit(directory: string, prefix: string, files: Listed[]) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = prefix + entry.name;
			const at = join(directory, entry.name);
			if (entry.isDirectory()) {
				// Git's state, and an older build's, are never a folder's files.
				if (path !== '.git' && path !== LEGACY_DIRECTORY)
					await visit(at, `${path}/`, files).catch((cause) => {
						if (codeOf(cause) !== 'ENOENT') throw cause;
					});
				continue;
			}
			if (!entry.isFile() || isReservedName(path)) continue;
			const listed = await describe(at, path);
			if (listed !== undefined) files.push(listed);
		}
	}

	/** The file at `path` now: its bytes and version from the one file opened, or gone. */
	async function readOne(path: string) {
		if (!readablePath(path))
			throw new Error(`The path '${path}' cannot be read safely`);
		let file: Awaited<ReturnType<typeof open>>;
		try {
			file = await open(join(root, path), 'r');
		} catch (cause) {
			const code = codeOf(cause);
			if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR')
				return { path, gone: true as const };
			throw cause;
		}
		try {
			const stats = await file.stat({ bigint: true });
			if (!stats.isFile()) return { path, gone: true as const };
			const bytes = new Uint8Array(await file.readFile());
			return { path, bytes, version: await blobIdOf(path, bytes) };
		} finally {
			await file.close();
		}
	}

	return {
		async list(under) {
			const files: Listed[] = [];
			// A path below another one asked for is walked once, with it.
			const prefixes = [...new Set(under)].filter(
				(prefix, _, all) =>
					!all.some((other) => other !== prefix && within(prefix, [other])),
			);
			try {
				for (const prefix of prefixes) {
					if (prefix === '') {
						await visit(root, '', files);
						continue;
					}
					const at = join(root, prefix);
					const stats = await lstat(at).catch((cause: unknown) => {
						const code = codeOf(cause);
						if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
						throw cause;
					});
					if (stats === undefined) continue;
					if (stats.isDirectory())
						await visit(at, `${prefix}/`, files).catch((cause) => {
							if (codeOf(cause) !== 'ENOENT') throw cause;
						});
					else if (!isReservedName(prefix)) {
						const listed = await describe(at, prefix);
						if (listed !== undefined) files.push(listed);
					}
				}
				if (prefixes.includes(''))
					await hashes.keepOnly(new Set(files.map(({ path }) => path)));
				await hashes.flush();
			} catch (cause) {
				return unavailable(cause);
			}
			return Ok(files);
		},
		async read(paths) {
			try {
				return Ok(await Promise.all(paths.map(readOne)));
			} catch (cause) {
				return unavailable(cause);
			}
		},
		async put(path, bytes, expect) {
			const refused = refusal(path, bytes, expect);
			if (refused !== undefined) return unavailable(refused);
			const target = join(root, path);
			let landing: Landing;
			try {
				landing =
					bytes !== null
						? await save(target, path, bytes, expect)
						: await turns.run(target, async (): Promise<Landing> => {
								const now = (await versionAt(target, path)) ?? null;
								if (now !== expect) return { moved: now };
								if (now !== null) await rm(target);
								return { landed: null };
							});
			} catch (cause) {
				return unavailable(cause);
			}
			if ('moved' in landing)
				return StoreError.Moved({ path, now: landing.moved });
			return Ok(landing.landed);
		},
		async watch(changed) {
			try {
				return Ok(await watchDirectory(root, changed));
			} catch (cause) {
				return unavailable(cause);
			}
		},
		close() {},
	};
}
