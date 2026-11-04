/** Clone into a temporary sibling before choosing the app's folder. */

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
import { resolveAppPaths } from '../app-paths.ts';
import { connect } from './connect.ts';
import { config, git, originPushUrl } from './git.ts';
import {
	type Initialized,
	type InitOptions,
	init,
	refuseReservedDirectory,
	repositoryRoot,
} from './setup.ts';
import { type SyncResult, syncFolder } from './sync.ts';

export type CloneSource = {
	readonly url: string;
	readonly name: string;
};

export type CloneResult = Initialized & {
	readonly naming?: string;
	readonly alreadyCloned?: boolean;
	readonly sync?: SyncResult;
};

export type CloneOptions = InitOptions;

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

async function cloneInto(url: string, target: string, options: InitOptions) {
	const cloned = await git(
		undefined,
		[
			'clone',
			'-q',
			'--no-recurse-submodules',
			'--template=',
			'--',
			url,
			target,
		],
		{
			env: { GIT_LFS_SKIP_SMUDGE: '1' },
			// The system git carries a token only over https; over http it
			// signs in through the person's own credential helper.
			credential: url.startsWith('https://')
				? await options.credential?.(url)
				: undefined,
		},
	);
	if (cloned.code !== 0)
		throw new Error(cloned.stderr.trim() || `git clone exited ${cloned.code}`);
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
	const root = await repositoryRoot(target);
	if (root !== null && root !== canonical)
		throw new Error(
			`${target} is inside the repository ${root}; cannot sync ${url}`,
		);
	if (root !== null) {
		const current = await config(root, 'remote.origin.url');
		if (current !== null && current !== url)
			throw new Error(
				`${target} has remote ${current}; cannot sync remote ${url}`,
			);
		if (current === url && (await originPushUrl(root)) !== url)
			throw new Error(`${target} fetches from ${url} but pushes elsewhere`);
	}
	const setup = await init(target, options);
	await connect(target, url);
	const sync = await syncFolder(target, options);
	return { ...setup, alreadyCloned: root !== null, sync };
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
