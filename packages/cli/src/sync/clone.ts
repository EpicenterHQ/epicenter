/**
 * `epicenter clone`: restore a repository into a temporary sibling with one
 * round of the sync core, which checks out the remote's `main` and its LFS
 * bytes (ADR-0735's restore, with nothing to add), then name the folder
 * from its `AGENTS.md` and move it into place. Cloning onto an occupied
 * folder is the consent to sync it with that remote: its files go on top of
 * the remote's `main` in the same round's first contact.
 */

import { existsSync } from 'node:fs';
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	rmdir,
	stat,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { agentsContract } from '@epicenter/definition/note';
import {
	hostFromSiteUrl,
	isRepositoryName,
	relativeFolderPath,
} from '@epicenter/definition/site';
import { connect as attach, locate, open } from '@epicenter/core';
import { resolveAppPaths } from '../app-paths.ts';
import { connect } from './connect.ts';
import {
	type Initialized,
	type InitOptions,
	init,
	refuseReservedDirectory,
} from './setup.ts';
import {
	type CredentialFor,
	round,
	type SyncResult,
	syncFolder,
} from './sync.ts';

export type CloneSource = {
	readonly url: string;
	readonly name: string;
};

export type CloneResult = Initialized & {
	readonly naming?: string;
	readonly alreadyCloned?: boolean;
	readonly sync?: SyncResult;
};

export type CloneOptions = InitOptions & {
	/** The token for the remote, asked for by its URL. */
	readonly credential?: CredentialFor;
};

export function localSource(source: string): CloneSource | undefined {
	if (
		!isAbsolute(source) &&
		!source.startsWith('./') &&
		!source.startsWith('../')
	)
		return undefined;
	const url = resolve(source);
	return { url, name: basename(url, '.git') };
}

type Named = { path: string; naming?: string };

async function nameFromNote(folder: string, fallback: string): Promise<Named> {
	const fallbackPath =
		fallback.includes('.') && isRepositoryName(fallback)
			? (() => {
					try {
						return relativeFolderPath(fallback);
					} catch {
						return fallback;
					}
				})()
			: fallback;
	let note: string;
	try {
		const entry = await lstat(join(folder, 'AGENTS.md'));
		if (!entry.isFile()) throw new Error('AGENTS.md must be a regular file');
		note = await readFile(join(folder, 'AGENTS.md'), 'utf8');
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
			return {
				path: fallbackPath,
				naming: `used repository name '${fallback}': no AGENTS.md`,
			};
		throw error;
	}
	const parsed = agentsContract(note);
	if (
		parsed.kind === 'missing' ||
		(parsed.kind === 'frontmatter' && !parsed.hasContract)
	)
		return {
			path: fallbackPath,
			naming: `used repository name '${fallback}': AGENTS.md has no contract key`,
		};
	if (parsed.kind === 'invalid')
		throw new Error(`AGENTS.md has invalid front matter: ${parsed.reason}`);
	if (typeof parsed.contract !== 'string')
		throw new Error('AGENTS.md contract must be a URL string');
	let origin: string;
	try {
		origin = new URL(parsed.contract).origin;
	} catch {
		throw new Error(`AGENTS.md contract is not a URL: ${parsed.contract}`);
	}
	return {
		path: relativeFolderPath(hostFromSiteUrl(origin)),
	};
}

/** Restore `url` into the empty folder `target`: a repository, its origin, and one round. */
async function cloneInto(url: string, target: string, options: CloneOptions) {
	open(target);
	attach(target, url);
	const restored = await round(target, url, options.credential);
	if (restored.status !== 'synced')
		throw new Error(restored.message ?? `the clone of ${url} did not finish`);
}

async function destination(target: string) {
	const entry = await lstat(target).catch((error: unknown) => {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
			return null;
		throw error;
	});
	if (entry === null) return { kind: 'missing' as const, path: target };
	const path = await realpath(target).catch(() => null);
	if (path === null || !(await stat(path)).isDirectory())
		throw new Error(`${target} is not an available directory`);
	return {
		kind:
			(await readdir(path)).length === 0
				? ('empty' as const)
				: ('occupied' as const),
		path,
		mode: (await stat(path)).mode,
	};
}

async function joinExisting(
	target: string,
	url: string,
	options: CloneOptions,
): Promise<CloneResult> {
	await refuseReservedDirectory(target);
	const canonical = await realpath(target);
	const found = locate(canonical);
	if (found !== null && found.root !== canonical)
		throw new Error(
			`${target} is inside the repository ${found.root}; cannot sync ${url}`,
		);
	if (found?.origin !== undefined && found.origin !== url)
		throw new Error(
			`${target} has remote ${found.origin}; cannot sync remote ${url}`,
		);
	const setup = await init(target, options);
	await connect(target, url);
	const sync = await syncFolder(target, options);
	return { ...setup, alreadyCloned: found !== null, sync };
}

async function createParents(path: string, created: string[]) {
	const missing: string[] = [];
	let cursor = path;
	while (!existsSync(cursor)) {
		missing.push(cursor);
		cursor = dirname(cursor);
	}
	created.push(...missing.reverse());
	await mkdir(path, { recursive: true });
}

/** Clone a new folder or turn on sync for an occupied folder. */
export async function clone(
	{ url, name }: CloneSource,
	dir: string | undefined,
	options: CloneOptions = {},
): Promise<CloneResult> {
	if (name === '') throw new Error(`'${url}' names no repository`);
	const library = resolveAppPaths().folderDir;
	const created: string[] = [];
	const firstParent = dir === undefined ? library : dirname(resolve(dir));
	let temporary: string | undefined;
	let placed: string | undefined;
	let restore: { path: string; mode: number } | undefined;
	let completed = false;
	try {
		await createParents(firstParent, created);
		temporary = await mkdtemp(join(firstParent, '.clone-'));
		await cloneInto(url, temporary, options);
		const named = await nameFromNote(temporary, name);
		const target =
			dir === undefined ? resolve(library, named.path) : resolve(dir);
		await refuseReservedDirectory(target);
		const state = await destination(target);
		if (state.kind === 'occupied') {
			const result = await joinExisting(target, url, options);
			completed = true;
			return { ...result, naming: named.naming };
		}
		await createParents(dirname(state.path), created);
		if (state.kind === 'empty') {
			if (state.path !== target)
				throw new Error(`${target} is a link; choose a missing directory`);
			await rmdir(state.path);
			restore = { path: state.path, mode: state.mode };
		}
		await rename(temporary, state.path);
		placed = state.path;
		const result = await init(target, options);
		completed = true;
		return { ...result, naming: named.naming };
	} finally {
		if (!completed && placed !== undefined)
			await rm(placed, { recursive: true, force: true });
		if (!completed && restore !== undefined)
			await mkdir(restore.path, { mode: restore.mode });
		if (temporary !== undefined)
			await rm(temporary, { recursive: true, force: true });
		if (!completed)
			for (const path of created.reverse())
				await rmdir(path).catch((error: unknown) => {
					if (
						error instanceof Error &&
						'code' in error &&
						(error.code === 'ENOTEMPTY' || error.code === 'ENOENT')
					)
						return;
					throw error;
				});
	}
}
