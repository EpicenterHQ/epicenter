/**
 * A device store over a directory, in Bun or Node, over `node:fs`: a plain
 * store that writes as ADR-0702 decides, without the desktop shell's
 * edge-case checks (the folder core's `storage.rs` stays the strict host).
 *
 * - A version is the file's stamp, whatever it holds: its size,
 *   modification time in nanoseconds, and identity, spelled as the desktop
 *   shell spells an attachment's. A listing names every file from its
 *   directory entry alone and never reads one, so a folder of ten thousand
 *   notes lists in the time of a walk. (The desktop shell hashes a note's
 *   bytes for its version; a version is opaque and belongs to the store that
 *   gave it, so a sync that meets another kind of version reads the file and
 *   finds the same bytes.) A write lands only while its path holds the
 *   version its writer read, checked right before the change. Its bytes are staged in the
 *   directory's `.epicenter/saves` (`savesDirectory`), so another program
 *   sees the old file or the new one, never part of either. A replacement
 *   is renamed over the path, keeping the replaced file's permission bits.
 *   A create is placed by a hard link, which the file system refuses when
 *   anything has the name, so of writers creating one path, in any process,
 *   exactly one lands.
 * - Within this process, writes to one path take turns from the check to the
 *   change (`createPathTurns`): of two writers over one version, one lands
 *   and the other is `stale`. Across processes nothing holds a path between
 *   a replacement's check and its rename; Git history is the backstop.
 * - A path on another file system than `.epicenter` (a mount point inside
 *   the directory) is one no rename reaches: that save fails saying so, and
 *   nothing is copied.
 * - A path that leaves the directory or names `.git` is refused, and a name
 *   only some disks hold (`pathProblem`) is never made; an existing one is
 *   replaced or removed over its version like any other.
 * - A listing is every regular file below the directories asked for, `.git`
 *   at the root aside, hidden ones included for its reader to skip
 *   (`isHiddenPath`). A file or directory removed while it lists is not
 *   listed.
 * - A watch answers once Node's recursive watcher is live (`watchDirectory`).
 *
 * A save a crash stopped leaves its staged file in `saves/`, hidden, never
 * committed, and safe to delete; the desktop shell sweeps it at its next
 * open of the folder, by the name `scratchName` gave it.
 */
import type { BigIntStats } from 'node:fs';
import {
	chmod,
	link,
	lstat,
	mkdir,
	open,
	readdir,
	rename,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ClientError } from '@epicenter/definition/contract';
import { Ok } from 'wellcrafted/result';
import { watchDirectory } from '../native/watch.js';
import { createPathTurns } from '../path-turns.js';
import { pathProblem, readablePath, writableExistingPath } from '../paths.js';
import { STATE_DIRECTORY, savesDirectory, scratchName } from '../state.js';
import {
	type Listed,
	type Store,
	type Version,
	within,
} from './store.js';

/** This process's writers to each path, taking turns from the check to the change. */
const turns = createPathTurns();

const codeOf = (cause: unknown) => (cause as { code?: unknown } | null)?.code;

/**
 * A file's version: its stamp, which every save changes. The form is the
 * shell's (`stamp_of` in the folder core's `storage.rs`): `v1`, the size,
 * the modification time in nanoseconds, then the device and inode where the
 * file system has one.
 */
const stampOf = (stats: BigIntStats) =>
	(stats.ino === 0n
		? `v1:${stats.size}:${stats.mtimeNs}`
		: `v1:${stats.size}:${stats.mtimeNs}:${stats.dev}:${stats.ino}`) as Version;

/** The version of the file at `target`, or undefined when nothing is there. */
async function versionAt(target: string) {
	try {
		return stampOf(await lstat(target, { bigint: true }));
	} catch (cause) {
		if (codeOf(cause) === 'ENOENT') return undefined;
		throw cause;
	}
}

const holds = (version: Version | undefined, over: Version | 'absent') =>
	over === 'absent' ? version === undefined : version === over;

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
	over: Version | 'absent',
) {
	const problem = pathProblem(path);
	if (problem === undefined) return undefined;
	// An existing nonportable name may be replaced or removed, never made.
	if (writableExistingPath(path) && (bytes === null || over !== 'absent'))
		return undefined;
	return `The path '${path}' is not usable: ${problem}`;
}

/** The store of the existing directory at `root`. */
export function nodeStore(root: string): Store {
	const saves = savesDirectory(root);
	const unavailable = (cause: unknown) => ClientError.Unavailable({ cause });

	/** Land `bytes` at `target` over `over`, staged in `saves`. */
	async function save(
		target: string,
		bytes: Uint8Array,
		over: Version | 'absent',
	) {
		const staged = `${saves}/${scratchName()}`;
		try {
			await mkdir(saves, { recursive: true, mode: 0o700 });
			await writeFile(staged, bytes, { flag: 'wx', mode: 0o600 });
			await mkdir(dirname(target), { recursive: true });
			return await turns.run(target, async () => {
				if (!holds(await versionAt(target), over))
					return 'stale' as const;
				if (over !== 'absent')
					await chmod(staged, (await stat(target)).mode & 0o777);
				// A rename or a link keeps the staged file's stamp: it is what lands.
				const landed = stampOf(await lstat(staged, { bigint: true }));
				if (over !== 'absent') await rename(staged, target);
				else if ((await place(staged, target)) === 'stale')
					return 'stale' as const;
				return landed;
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
			return {
				path,
				version: stampOf(stats),
				size: Number(stats.size),
			} satisfies Listed;
		} catch (cause) {
			if (codeOf(cause) === 'ENOENT') return undefined;
			throw cause;
		}
	}

	/** Every regular file below `directory` (the folder's `prefix`), into `files`. */
	async function visit(directory: string, prefix: string, files: Listed[]) {
		// The files of one directory are stamped together; they list in the
		// order `readdir` gave them, after the directories walked before them.
		const stamped: Promise<Listed | undefined>[] = [];
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = prefix + entry.name;
			const at = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (path !== '.git')
					await visit(at, `${path}/`, files).catch((cause) => {
						if (codeOf(cause) !== 'ENOENT') throw cause;
					});
				continue;
			}
			if (entry.isFile()) stamped.push(describe(at, path));
		}
		const stamps = Promise.all(stamped);
		// A walk that throws before the stamps are awaited leaves none unhandled.
		stamps.catch(() => {});
		for (const listed of await stamps)
			if (listed !== undefined) files.push(listed);
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
			return {
				path,
				bytes,
				version: stampOf(stats),
			};
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
					else {
						const listed = await describe(at, prefix);
						if (listed !== undefined) files.push(listed);
					}
				}
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
		async write(path, bytes, over) {
			const refused = refusal(path, bytes, over);
			if (refused !== undefined) return unavailable(refused);
			const target = join(root, path);
			try {
				if (bytes !== null) return Ok(await save(target, bytes, over));
				return Ok(
					await turns.run(target, async () => {
						const version = await versionAt(target);
						if (!holds(version, over)) return 'stale' as const;
						if (version !== undefined) await rm(target);
						return null;
					}),
				);
			} catch (cause) {
				if (codeOf(cause) !== 'EXDEV') return unavailable(cause);
				return unavailable(
					`cannot save across a mount point: '${path}' is on another file system than the folder's ${STATE_DIRECTORY}, so nothing was written there`,
				);
			}
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
