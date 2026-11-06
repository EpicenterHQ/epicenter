/**
 * The Epicenter folder and the folders in it, on this computer through
 * `node:fs` (ADR-0813): every directory directly inside `~/Epicenter`,
 * followed through a symbolic link to wherever it lives, and each one's
 * identity (device and inode), which a manifest records so a copy is told
 * apart from the folder it was copied from (ADR-0811).
 */
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { ClientError } from '@epicenter/definition/contract';
import { Ok, type Result } from 'wellcrafted/result';
import type {
	EpicenterRoot,
	LocalFolder,
} from '../platform/epicenter-folder.js';
import type { RootIdentity } from '../sync/sync.js';
import { nodeStore } from './node-store.js';
import type { Unavailable } from './store.js';

/** The identity of the directory at `path`, its link followed. */
export async function rootIdentity(path: string): Promise<RootIdentity> {
	const found = await stat(path, { bigint: true });
	return { device: found.dev.toString(), inode: found.ino.toString() };
}

/** A segment no folder may be inside: Git's records, or Epicenter's own. */
const RECORDS = new Set(['.git', '.epicenter']);

/**
 * The folder at `path` (made with its missing parents when `make`), or why
 * it cannot be one: it does not exist, is not a directory, or lies inside a
 * `.git` or `.epicenter` directory, whose files are records, never a
 * folder's.
 */
export async function localFolder(
	path: string,
	{ make = false }: { make?: boolean } = {},
): Promise<Result<LocalFolder, Unavailable>> {
	const absolute = resolve(path);
	const inside = absolute.split(sep).find((segment) => RECORDS.has(segment));
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
		return Ok({
			name: absolute.split(sep).at(-1) ?? absolute,
			path: absolute,
			store: nodeStore(absolute),
			identity: await rootIdentity(absolute),
		});
	} catch (cause) {
		return ClientError.Unavailable({ cause });
	}
}

/**
 * The Epicenter folder at `path` (`~/Epicenter`, or `~/Epicenter Dev` in
 * development), made when it is missing: its folders are the directories
 * directly inside it, links followed, hidden names skipped.
 */
export function epicenterRoot(path: string): EpicenterRoot {
	const root = resolve(path);
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
			const unreadable: { name: string; reason: string }[] = [];
			for (const name of names.sort()) {
				if (name.startsWith('.')) continue;
				const at = join(root, name);
				const found = await stat(at).catch((cause: unknown) => cause);
				if (found instanceof Error) {
					unreadable.push({
						name,
						reason:
							(found as { code?: unknown }).code === 'ENOENT'
								? 'it links to a folder that is gone'
								: found.message,
					});
					continue;
				}
				if (!(found as { isDirectory(): boolean }).isDirectory()) continue;
				const local = await localFolder(at);
				if (local.error !== null)
					unreadable.push({ name, reason: local.error.message });
				else folders.push({ ...local.data, name });
			}
			return Ok({ folders, unreadable });
		},
		async make(name) {
			const at = join(root, name);
			try {
				await mkdir(root, { recursive: true });
				await mkdir(at);
			} catch (cause) {
				return ClientError.Unavailable({ cause });
			}
			return localFolder(at);
		},
	};
}
