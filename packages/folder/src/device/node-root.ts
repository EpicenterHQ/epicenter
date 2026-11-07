/**
 * The Epicenter folder and the folders in it, on this computer through
 * `node:fs` (ADR-0813, ADR-0822, ADR-0825): every real directory directly
 * inside `~/Epicenter`, each with its identity (inode and birth time,
 * `FolderIdentity`) and whether Git keeps it; each link there, listed as
 * outside it and never opened; and the Epicenter folder's own `.epicenter`,
 * which holds the records of what this computer synced and each directory's
 * hash cache.
 *
 * Listing a folder also tidies it: stale saves anywhere in it are removed
 * (`sweepSaves`), and what an older build kept in its `.epicenter` is
 * recovered and pruned (`tidyLegacy`), recordings first and never deleted.
 */
import {
	link,
	lstat,
	mkdir,
	readdir,
	readlink,
	rm,
	rmdir,
	stat,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { ClientError } from '@epicenter/definition/contract';
import { Ok, type Result } from 'wellcrafted/result';
import {
	type FolderIdentity,
	type IdentityStats,
	identityOf,
} from '../identity.js';
import type {
	EpicenterRoot,
	LocalFolder,
	OutsideLink,
} from '../platform/epicenter-folder.js';
import { recordsIn } from '../platform/records.js';
import {
	EPICENTER_STATE,
	isSaveName,
	LEGACY_RECORDINGS,
	LEGACY_SAVES,
	LEGACY_DIRECTORY,
	recordingName,
	STALE_SAVE_MS,
} from '../state.js';
import { nodeStore } from './node-store.js';
import type { Unavailable } from './store.js';

/** How a directory's identity is read: `stat` with its link followed. A test passes its own. */
export type StatIdentity = (path: string) => Promise<IdentityStats>;

const statIdentity: StatIdentity = (path) => stat(path, { bigint: true });

/** The identity of the directory at `path`, its link followed. */
export async function folderIdentity(
	path: string,
	read: StatIdentity = statIdentity,
): Promise<FolderIdentity> {
	return identityOf(await read(path));
}

/** A segment no folder may be inside: Git's records, or Epicenter's own. */
const RECORD_SEGMENTS = new Set(['.git', EPICENTER_STATE]);

/** Whether anything is at `path`, a link not followed. */
const exists = async (path: string) =>
	(await lstat(path).catch(() => undefined)) !== undefined;

/**
 * Whether Git keeps the directory at `at` (ADR-0822, ADR-0825): anything
 * named `.git` at its root, a directory or a worktree's file, found with one
 * look and no search above it.
 */
export const keptByGit = (at: string) => exists(join(at, '.git'));

/**
 * Remove every staged save (`.ep-<random>.save`) in the folder at `root`
 * that was last changed over an hour before `now`, at any depth: its writer
 * stopped. Links are not followed and `.git` is not read; a recording in
 * progress, and every other hidden file, stays.
 */
export async function sweepSaves(root: string, now = Date.now()) {
	async function visit(directory: string) {
		let entries: import('node:fs').Dirent[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const at = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== '.git') await visit(at);
				continue;
			}
			if (!entry.isFile() || !isSaveName(entry.name)) continue;
			const found = await lstat(at).catch(() => undefined);
			if (found !== undefined && now - found.mtimeMs > STALE_SAVE_MS)
				await rm(at, { force: true }).catch(() => {});
		}
	}
	await visit(root);
}

/** Remove `directory` and the directories in it when they hold nothing. */
async function pruneEmpty(directory: string): Promise<boolean> {
	let entries: import('node:fs').Dirent[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return false;
	}
	let empty = true;
	for (const entry of entries)
		if (
			!entry.isDirectory() ||
			!(await pruneEmpty(join(directory, entry.name)))
		)
			empty = false;
	if (!empty) return false;
	return rmdir(directory).then(
		() => true,
		() => false,
	);
}

/**
 * Recover and prune what an older build kept in the folder at `root`'s own
 * `.epicenter` (ADR-0822): each recording in `.epicenter/recordings/` last
 * changed over an hour ago is moved beside its final path under a
 * recording's reserved name, for its recorder to finish (never deleted, and
 * left where it is when it cannot move); stale saves in `.epicenter/saves/`
 * go; then every directory there that holds nothing, and `.epicenter`
 * itself once empty. Its manifest and hash cache stay for the import
 * (`importLegacy`) to read and remove.
 */
export async function tidyLegacy(root: string, now = Date.now()) {
	const legacy = join(root, LEGACY_DIRECTORY);
	if (!(await exists(legacy))) return;
	const recordings = join(root, LEGACY_RECORDINGS);
	async function recover(directory: string, relative: string) {
		let entries: import('node:fs').Dirent[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const at = join(directory, entry.name);
			const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
			if (entry.isDirectory()) {
				await recover(at, path);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith('.webm')) continue;
			const found = await lstat(at).catch(() => undefined);
			if (found === undefined || now - found.mtimeMs <= STALE_SAVE_MS) continue;
			const target = join(
				root,
				dirname(path),
				recordingName(entry.name.slice(0, -'.webm'.length)),
			);
			try {
				await mkdir(dirname(target), { recursive: true });
				// A link never replaces anything; the old name goes only once it holds.
				await link(at, target);
				await rm(at);
			} catch {
				// It stays where it is, and the folder's `.epicenter` with it.
			}
		}
	}
	await recover(recordings, '');
	// An older build's staged saves, by whatever name it gave them.
	const saves = join(root, LEGACY_SAVES);
	for (const entry of await readdir(saves, { withFileTypes: true }).catch(
		() => [],
	)) {
		if (!entry.isFile()) continue;
		const found = await lstat(join(saves, entry.name)).catch(() => undefined);
		if (found !== undefined && now - found.mtimeMs > STALE_SAVE_MS)
			await rm(join(saves, entry.name), { force: true }).catch(() => {});
	}
	await pruneEmpty(saves);
	await pruneEmpty(recordings);
	await rmdir(legacy).catch(() => {});
}

/**
 * The folder at `path` (made with its missing parents when `make`), or why
 * it cannot be one: it does not exist, is not a directory, or lies inside a
 * `.git` or `.epicenter` directory, whose files are records, never a
 * folder's. `hashes` names where its hash cache is kept, by its identity.
 */
export async function localFolder(
	path: string,
	{
		make = false,
		stat: read = statIdentity,
		hashes,
	}: {
		make?: boolean;
		stat?: StatIdentity;
		hashes?: (
			identity: FolderIdentity,
		) => import('./stamp-cache.js').StampFile | null;
	} = {},
): Promise<Result<LocalFolder, Unavailable>> {
	const absolute = resolve(path);
	const inside = absolute
		.split(sep)
		.find((segment) => RECORD_SEGMENTS.has(segment));
	if (inside !== undefined)
		return ClientError.Unavailable({
			cause: `${absolute} is inside a ${inside} directory, which holds records, not a folder`,
		});
	try {
		if (make) await mkdir(absolute, { recursive: true });
		const found = await stat(absolute).catch(() => undefined);
		if (found === undefined)
			return ClientError.Unavailable({ cause: `${absolute} does not exist` });
		if (!found.isDirectory())
			return ClientError.Unavailable({
				cause: `${absolute} is not a folder`,
			});
		const identity = await folderIdentity(absolute, read);
		return Ok({
			name: absolute.split(sep).at(-1) ?? absolute,
			path: absolute,
			store: nodeStore(absolute, { hashes: hashes?.(identity) ?? null }),
			identity,
			git: await keptByGit(absolute),
		});
	} catch (cause) {
		return ClientError.Unavailable({ cause });
	}
}

/**
 * The Epicenter folder at `path` (`~/Epicenter`, or `~/Epicenter Dev` in
 * development), made when it is missing: its folders are the real
 * directories directly inside it, hidden names skipped; a link to a folder,
 * or to nothing, is listed as outside it and never opened (ADR-0825).
 * `stat` reads a directory's identity, for a test that stands in for a file
 * system.
 */
export function epicenterRoot(
	path: string,
	{ stat: read = statIdentity }: { stat?: StatIdentity } = {},
): EpicenterRoot {
	const root = resolve(path);
	const records = recordsIn(nodeStore(join(root, EPICENTER_STATE)));
	const open = async (name: string) => {
		const at = join(root, name);
		await sweepSaves(at);
		await tidyLegacy(at);
		const local = await localFolder(at, {
			stat: read,
			hashes: (identity) => records.hashes(identity),
		});
		if (local.error !== null) return local;
		return Ok({ ...local.data, name });
	};
	return {
		path: root,
		async list() {
			let names: string[];
			try {
				await mkdir(root, { recursive: true });
				names = await readdir(root);
			} catch (cause) {
				return ClientError.Unavailable({ cause });
			}
			const folders: LocalFolder[] = [];
			const outside: OutsideLink[] = [];
			const unreadable: { name: string; reason: string }[] = [];
			for (const name of names.sort()) {
				if (name.startsWith('.')) continue;
				const at = join(root, name);
				const found = await lstat(at).catch((cause: unknown) => cause);
				if (found instanceof Error) {
					unreadable.push({ name, reason: found.message });
					continue;
				}
				const entry = found as import('node:fs').Stats;
				if (entry.isSymbolicLink()) {
					// A link to a file is no folder; one to a folder, or to
					// nothing, is a folder kept outside.
					const target = await stat(at).catch(() => undefined);
					if (target !== undefined && !target.isDirectory()) continue;
					outside.push({
						name,
						path: at,
						target: await readlink(at).catch(() => ''),
					});
					continue;
				}
				if (!entry.isDirectory()) continue;
				const local = await open(name);
				if (local.error !== null)
					unreadable.push({ name, reason: local.error.message });
				else folders.push(local.data);
			}
			return Ok({ folders, outside, unreadable, git: await keptByGit(root) });
		},
		async make(name) {
			const at = join(root, name);
			try {
				await mkdir(root, { recursive: true });
				await mkdir(at);
			} catch (cause) {
				return ClientError.Unavailable({ cause });
			}
			return open(name);
		},
		async records() {
			return Ok(records);
		},
	};
}
