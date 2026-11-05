/**
 * A device store over a directory, in Bun or Node, over `node:fs`: a plain
 * store that writes as ADR-0702 decides, without the desktop shell's
 * edge-case checks (the folder core's `storage.rs` stays the strict host).
 *
 * - A write lands only while its path holds the version its writer read
 *   (`DeviceExpectation`), checked right before the change. Its bytes are
 *   staged in the directory's `.epicenter/saves` (`savesDirectory`), so
 *   another program sees the old file or the new one, never part of either.
 *   A replacement is renamed over the path, keeping the replaced file's
 *   permission bits. A create is placed by a hard link, which the file
 *   system refuses when anything has the name, so of writers creating one
 *   path, in any process, exactly one lands.
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
 * - A listing is every regular file below the directory, `.git` at its root
 *   aside, hidden ones included for its reader to skip (`isHiddenPath`). A
 *   file or directory removed while it lists is not listed; only the
 *   directory itself missing fails it.
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
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ClientError, type Version } from '@epicenter/definition/contract';
import { Ok } from 'wellcrafted/result';
import { createChanges } from '../changes.js';
import { hashBytes } from '../hash.js';
import { watchDirectory } from '../native/watch.js';
import { createPathTurns } from '../path-turns.js';
import { pathProblem, readablePath, writableExistingPath } from '../paths.js';
import { STATE_DIRECTORY, savesDirectory, scratchName } from '../state.js';
import type { DeviceExpectation, DeviceStore } from './store.js';

/** This process's writers to each path, taking turns from the check to the change. */
const turns = createPathTurns();

const codeOf = (cause: unknown) => (cause as { code?: unknown } | null)?.code;

/** A file's stamp: its size, modification time, and identity, which every save changes. */
const stampOf = (stats: BigIntStats) =>
	`${stats.size}:${stats.mtimeNs}:${stats.ino}`;

/** The version of the file at `target`, or undefined when nothing is there. */
async function versionAt(target: string) {
	try {
		return await hashBytes(new Uint8Array(await readFile(target)));
	} catch (cause) {
		if (codeOf(cause) === 'ENOENT') return undefined;
		throw cause;
	}
}

const holds = (version: string | undefined, expected: DeviceExpectation) =>
	expected === 'absent' ? version === undefined : version === expected.version;

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
	expected: DeviceExpectation,
) {
	const problem = pathProblem(path);
	if (problem === undefined) return undefined;
	// An existing nonportable name may be replaced or removed, never made.
	if (writableExistingPath(path) && (bytes === null || expected !== 'absent'))
		return undefined;
	return `The path '${path}' is not usable: ${problem}`;
}

/** The store of the existing directory at `root`. */
export function nodeStore(root: string): DeviceStore {
	const saves = savesDirectory(root);
	const unavailable = (cause: unknown) => ClientError.Unavailable({ cause });

	// Every change below the directory, its own writes included. A directory
	// that is not there has nothing to hear.
	const changes = createChanges((emit) => {
		try {
			return watchDirectory(root)(emit);
		} catch {
			return () => {};
		}
	});

	/** Land `bytes` at `target` over `expected`, staged in `saves`. */
	async function save(
		target: string,
		bytes: Uint8Array,
		expected: DeviceExpectation,
	) {
		const staged = `${saves}/${scratchName()}`;
		try {
			await mkdir(saves, { recursive: true, mode: 0o700 });
			await writeFile(staged, bytes, { flag: 'wx', mode: 0o600 });
			await mkdir(dirname(target), { recursive: true });
			const landed = await turns.run(target, async () => {
				if (expected === 'absent') return place(staged, target);
				if (!holds(await versionAt(target), expected)) return 'stale' as const;
				await chmod(staged, (await stat(target)).mode & 0o777);
				await rename(staged, target);
				return 'landed' as const;
			});
			if (landed === 'stale') return landed;
			return { landed: (await hashBytes(bytes)) as Version };
		} finally {
			await rm(staged, { force: true });
		}
	}

	return {
		async list() {
			const files: { path: string; stamp: string }[] = [];
			async function visit(directory: string, prefix: string) {
				for (const entry of await readdir(directory, { withFileTypes: true })) {
					const path = prefix + entry.name;
					const at = join(directory, entry.name);
					if (entry.isDirectory()) {
						if (path !== '.git')
							await visit(at, `${path}/`).catch((cause) => {
								if (codeOf(cause) !== 'ENOENT') throw cause;
							});
						continue;
					}
					if (!entry.isFile()) continue;
					const stats = await lstat(at, { bigint: true }).catch(
						() => undefined,
					);
					if (stats !== undefined) files.push({ path, stamp: stampOf(stats) });
				}
			}
			try {
				await visit(root, '');
			} catch (cause) {
				return unavailable(cause);
			}
			return Ok(files);
		},
		async read(path) {
			if (!readablePath(path))
				return unavailable(`The path '${path}' cannot be read safely`);
			let file: Awaited<ReturnType<typeof open>>;
			try {
				file = await open(join(root, path), 'r');
			} catch (cause) {
				const code = codeOf(cause);
				if (code === 'ENOENT' || code === 'ENOTDIR') return Ok(null);
				return unavailable(cause);
			}
			// The bytes and the stamp come from the one file opened.
			try {
				const stats = await file.stat({ bigint: true });
				const bytes = new Uint8Array(await file.readFile());
				const version = (await hashBytes(bytes)) as Version;
				return Ok({ bytes, version, stamp: stampOf(stats) });
			} catch (cause) {
				return unavailable(cause);
			} finally {
				await file.close();
			}
		},
		async write(path, bytes, expected) {
			const refused = refusal(path, bytes, expected);
			if (refused !== undefined) return unavailable(refused);
			const target = join(root, path);
			try {
				if (bytes !== null) return Ok(await save(target, bytes, expected));
				return Ok(
					await turns.run(target, async () => {
						const version = await versionAt(target);
						if (!holds(version, expected)) return 'stale' as const;
						if (version !== undefined) await rm(target);
						return { landed: null };
					}),
				);
			} catch (cause) {
				if (codeOf(cause) !== 'EXDEV') return unavailable(cause);
				return unavailable(
					`cannot save across a mount point: '${path}' is on another file system than the folder's ${STATE_DIRECTORY}, so nothing was written there`,
				);
			}
		},
		watch: changes.watch,
	};
}
