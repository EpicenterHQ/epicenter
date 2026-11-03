/** Clone a repository into its app's named folder, or join a folder already there. */

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
	stat,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
	hostFromSiteUrl,
	relativeFolderPath,
} from '@epicenter/constants/app-names';
import { agentsContract } from '@epicenter/definition/note';
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
	/** What `git clone` is given: a URL or an absolute path. */
	readonly url: string;
	/** The repository's name, used when the note has no contract. */
	readonly name: string;
};

export type CloneResult = Initialized & {
	readonly naming?: string;
	readonly alreadyCloned?: boolean;
	readonly sync?: SyncResult;
};

/** A local repository named by its path, as plain `git clone` takes one. */
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

async function nameFromNote(folder: string, fallback: string) {
	let note: string;
	try {
		note = await readFile(join(folder, 'AGENTS.md'), 'utf8');
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
			return {
				path: fallback,
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
			path: fallback,
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
	return { path: relativeFolderPath(hostFromSiteUrl(origin)) };
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
			credential: await options.credential?.(url),
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
	};
}

async function joinExisting(
	target: string,
	url: string,
	options: InitOptions,
): Promise<CloneResult> {
	await refuseReservedDirectory(target);
	const canonical = await realpath(target);
	const root = await repositoryRoot(target);
	if (root !== null && root !== canonical)
		throw new Error(
			`${target} is inside the repository ${root}; cannot join ${url}`,
		);
	if (root !== null) {
		const current = await config(root, 'remote.origin.url');
		if (current !== null && current !== url)
			throw new Error(
				`${target} has remote ${current}; cannot join remote ${url}`,
			);
		if (current === url) {
			const push = await originPushUrl(root);
			if (push !== url)
				throw new Error(
					`${target} fetches from ${url} but pushes to ${push}; cannot join remote ${url}`,
				);
			return {
				folder: target,
				repository: root,
				changed: [],
				warnings: [],
				alreadyCloned: true,
			};
		}
	}
	const commandLink = resolveAppPaths().commandLink;
	if (!existsSync(commandLink))
		throw new Error(
			`cannot join ${target} with ${url}: ${commandLink} is missing. Run epicenter install-command first.`,
		);
	const setup = await init(target, options);
	await connect(target, url);
	const round = await syncFolder(target, options);
	const sync =
		round.status === 'stopped' && round.message !== undefined
			? {
					...round,
					message: `${target} could not join ${url}: ${round.message}`,
				}
			: round;
	return { ...setup, sync };
}

/** Clone or join, with an implicit target derived from the cloned note. */
export async function clone(
	{ url, name }: CloneSource,
	dir: string | undefined,
	options: InitOptions,
): Promise<CloneResult> {
	if (name === '') throw new Error(`'${url}' names no repository`);
	const library = resolveAppPaths().folderDir;
	if (dir !== undefined) {
		const target = resolve(dir);
		await refuseReservedDirectory(target);
		const state = await destination(target);
		if (state.kind === 'occupied') return joinExisting(target, url, options);
		await mkdir(dirname(state.path), { recursive: true });
		const temporary = await mkdtemp(join(dirname(state.path), '.clone-'));
		let placed = false;
		try {
			await cloneInto(url, temporary, options);
			await rename(temporary, state.path);
			placed = true;
			return await init(target, options);
		} catch (error) {
			if (placed) {
				await rm(state.path, { recursive: true, force: true });
				if (state.kind === 'empty') await mkdir(state.path);
			}
			throw error;
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}

	await mkdir(library, { recursive: true });
	const temporary = await mkdtemp(join(library, '.clone-'));
	let placed: string | undefined;
	let wasEmpty = false;
	try {
		await cloneInto(url, temporary, options);
		const named = await nameFromNote(temporary, name);
		const target = resolve(library, named.path);
		await refuseReservedDirectory(target);
		const state = await destination(target);
		if (state.kind === 'occupied')
			return {
				...(await joinExisting(target, url, options)),
				naming: named.naming,
			};
		await mkdir(dirname(target), { recursive: true });
		await rename(temporary, state.path);
		placed = state.path;
		wasEmpty = state.kind === 'empty';
		const result = await init(target, options);
		placed = undefined;
		return { ...result, naming: named.naming };
	} catch (error) {
		if (placed !== undefined) {
			await rm(placed, { recursive: true, force: true });
			if (wasEmpty) await mkdir(placed);
		}
		throw error;
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}
