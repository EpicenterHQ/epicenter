/**
 * `epicenter init` and `epicenter forget`: put a data folder under
 * Epicenter's history, or take it out (decisions 36, 39, 41), through the
 * sync core, with no `git` program.
 *
 * `init` is set-up-or-repair and idempotent: each step checks first, changes
 * only what is missing or wrong, and says what it changed. A folder inside a
 * `.git` or `.epicenter` directory is refused before anything is made
 * (`refuseReservedDirectory`). A folder inside another repository's working
 * tree is refused, and so is a repository in a state only a person can
 * finish, with the command that does (the core's `open`). Consent to sync
 * is recorded as `epicenter.synced = true` in the folder's local repository
 * configuration (ADR-0750).
 */

import { existsSync } from 'node:fs';
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { locate, open, setSynced } from '@epicenter/core';
import { REPOSITORY_ATTRIBUTES } from '@epicenter/definition/contract';
import {
	isPersonalFolderName,
	suggestLibraryLinkName,
} from '@epicenter/definition/site';
import {
	EPICENTER_BUNDLE_IDENTIFIER,
	epicenterDataRoot,
} from '@epicenter/definition/site/app-data';
import { resolveAppPaths } from '../app-paths.ts';
import { canonicalPath, containsPath, reservedSegment } from './admission.ts';
import { REPOSITORY_IGNORE, withEpicenterBlock } from './managed-block.ts';

/**
 * The folder is protected state, a library root, home, or inside another repository.
 */
export class Refused extends Error {}

/**
 * Refuse protected paths after resolving links, before making anything there.
 */
export async function refuseReservedDirectory(input: string): Promise<void> {
	const canonical = await canonicalPath(input);
	const reserved = reservedSegment(canonical);
	if (reserved !== undefined)
		throw new Refused(
			`${canonical} is in a ${reserved} directory; choose a folder outside it.`,
		);
	const paths = resolveAppPaths();
	const home = await canonicalPath(resolve(paths.folderDir, '..'));
	if (canonical === home)
		throw new Refused(
			`${canonical} is your home folder; choose a folder inside it, such as ~/Epicenter/<name>.`,
		);
	if (containsPath(canonical, home))
		throw new Refused(
			`${canonical} contains your home folder; choose a folder inside ~/Epicenter instead.`,
		);
	for (const name of ['Epicenter', 'Epicenter Dev']) {
		const library = await canonicalPath(join(home, name));
		if (canonical === library)
			throw new Refused(
				`${canonical} is your ${name} library folder; choose a folder inside it.`,
			);
		if (containsPath(canonical, library))
			throw new Refused(
				`${canonical} contains your ${name} library folder; choose a folder inside ${library} instead.`,
			);
	}
	const platformEnv = { ...process.env, EPICENTER_DATA_DIR: undefined };
	const dataDirs = [
		paths.dataDir,
		epicenterDataRoot(
			{ env: platformEnv, platform: process.platform, homeDir: home },
			EPICENTER_BUNDLE_IDENTIFIER,
		),
		epicenterDataRoot(
			{ env: platformEnv, platform: process.platform, homeDir: home },
			`${EPICENTER_BUNDLE_IDENTIFIER}.dev`,
		),
	];
	for (const directory of dataDirs) {
		const data = await canonicalPath(directory);
		if (canonical === data)
			throw new Refused(
				`${canonical} is Epicenter's application data folder; choose a different folder.`,
			);
		if (containsPath(data, canonical))
			throw new Refused(
				`${canonical} is inside Epicenter's application data folder ${data}; choose a different folder.`,
			);
		if (containsPath(canonical, data))
			throw new Refused(
				`${canonical} contains Epicenter's application data folder ${data}; choose a different folder.`,
			);
	}
}

/** The top of the repository `folder` is in, links resolved, or null. */
export function repositoryRoot(folder: string): string | null {
	return locate(folder)?.root ?? null;
}

export type InitOptions = {
	/** Library link name for a folder outside the scan. */
	readonly name?: string;
};

export type Initialized = {
	readonly folder: string;
	readonly repository: string;
	/** What init changed, in order; empty when nothing was missing. */
	readonly changed: string[];
	/** What init could not fix and the person should know. */
	readonly warnings: string[];
};

/**
 * Set up or repair `input` for Epicenter sync. Throws `Refused` for a
 * folder inside a `.git` or `.epicenter` directory, and for an enclosing
 * repository.
 */
export async function init(
	input: string,
	options: InitOptions = {},
): Promise<Initialized> {
	const prepared = await prepareFolder(input, options);
	if (setSynced(await realpath(prepared.folder), true))
		prepared.changed.push('epicenter.synced = true');
	return prepared;
}

/** Give the scan a stable library path before local consent is recorded. */
async function ensureDiscoverable(
	target: string,
	changed: string[],
	name: string | undefined,
	suggestion: string,
): Promise<void> {
	const { discoveredFolders } = await import('./discovery.ts');
	for (const entry of await discoveredFolders()) {
		if ((await realpath(entry.folder).catch(() => null)) === target) return;
	}
	const library = resolveAppPaths().folderDir;
	if (name === undefined)
		throw new Refused(
			`${target} is not reachable by the library scan; retry with --name "${suggestion}".`,
		);
	const link = join(library, name);
	const existing = await lstat(link).catch((error: unknown) => {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
			return null;
		throw error;
	});
	if (existing !== null) {
		if ((await realpath(link).catch(() => null)) === target) return;
		const occupant = (await realpath(link).catch(() => null)) ?? link;
		throw new Refused(
			`${target} cannot use '${name}' at ${link}: it belongs to ${occupant}. Try --name "${suggestion}".`,
		);
	}
	await mkdir(library, { recursive: true });
	await symlink(
		target,
		link,
		process.platform === 'win32' ? 'junction' : 'dir',
	);
	changed.push(`linked at ${link}`);
}

/** Set up Git and LFS, and make the folder reachable before recording consent. */
async function prepareFolder(
	input: string,
	{ name }: InitOptions = {},
): Promise<Initialized> {
	await refuseReservedDirectory(input);
	const folder = resolve(input);
	if (!existsSync(folder)) {
		let parent = dirname(folder);
		while (!existsSync(parent)) parent = dirname(parent);
		const enclosing = repositoryRoot(await realpath(parent));
		if (enclosing !== null)
			throw new Refused(
				`${folder} is inside the Git repository ${enclosing}; choose a folder outside it.`,
			);
	}
	const libraryPath = resolveAppPaths().folderDir;
	const library = await canonicalPath(libraryPath);
	const canonical = await canonicalPath(folder);
	const relative = containsPath(libraryPath, folder)
		? folder.slice(libraryPath.length + 1)
		: containsPath(library, canonical)
			? canonical.slice(library.length + 1)
			: null;
	const scanned = relative !== null && relative.split(/[\\/]/).length <= 2;
	const entries = await readdir(library).catch((error: unknown) => {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
			return [];
		throw error;
	});
	const baseSuggestion = suggestLibraryLinkName(basename(folder));
	let suggestion = baseSuggestion;
	for (
		let suffix = 2;
		entries.some((entry) => entry.toLowerCase() === suggestion.toLowerCase());
		suffix++
	)
		suggestion = `${baseSuggestion} ${suffix}`;
	if (!scanned && name === undefined)
		throw new Refused(
			`${folder} needs a library link name; retry with --name "${suggestion}".`,
		);
	if (name !== undefined) {
		if (
			name.trim() !== name ||
			!name ||
			name === '.' ||
			name === '..' ||
			/[<>:"/\\|?*\x00-\x1f]/.test(name)
		)
			throw new Refused(
				`'${name}' is not a usable library link name. Try --name "${suggestion}".`,
			);
		if (!isPersonalFolderName(name))
			throw new Refused(
				`'${name}' has no space; names without a space belong to apps and owners. Try --name "${suggestion}".`,
			);
		const occupied = entries.find(
			(entry) => entry.toLowerCase() === name.toLowerCase(),
		);
		if (occupied !== undefined) {
			const link = join(library, occupied);
			const occupant = (await realpath(link).catch(() => null)) ?? link;
			if (occupant !== canonical)
				throw new Refused(
					`${folder} cannot use '${name}' at ${link}: it belongs to ${occupant}. Try --name "${suggestion}".`,
				);
		}
	}
	await mkdir(folder, { recursive: true });
	const target = await realpath(folder);
	const { discoveredFolders } = await import('./discovery.ts');
	for (const entry of await discoveredFolders()) {
		const child = await realpath(entry.folder).catch(() => null);
		if (child !== null && child !== target && containsPath(target, child))
			throw new Refused(
				`${folder} contains the repository ${entry.folder}; choose that repository instead.`,
			);
	}
	const changed: string[] = [];
	const warnings: string[] = [];

	// 1. The folder must be its own repository, on `main` with nothing in
	// progress, with the Git LFS filter settings: values, not paths or
	// hooks (ADR-0733). Sync moves LFS objects itself.
	const top = repositoryRoot(target);
	if (top !== null && top !== target)
		throw new Refused(
			`${folder} is inside the Git repository ${top}; choose a folder outside it.`,
		);
	let opened: ReturnType<typeof open>;
	try {
		opened = open(target);
	} catch (error) {
		throw new Refused(error instanceof Error ? error.message : String(error));
	}
	if (opened.initialized) changed.push('git init');
	for (const key of opened.configured) changed.push(`${key} set`);
	// 2. Epicenter's blocks of the folder's committed attributes and ignore rules.
	const managed = [
		['.gitattributes', REPOSITORY_ATTRIBUTES],
		['.gitignore', REPOSITORY_IGNORE],
	] as const;
	for (const [name, block] of managed) {
		const path = join(target, name);
		const current = existsSync(path) ? await readFile(path, 'utf8') : null;
		const wanted = withEpicenterBlock(current, block);
		if (current !== wanted) {
			await writeFile(path, wanted);
			changed.push(`${name} written`);
		}
	}

	await ensureDiscoverable(target, changed, name, suggestion);
	return { folder, repository: target, changed, warnings };
}

/**
 * Take `input` out of Epicenter's sync by clearing local consent.
 * The files, repository, and history stay as they are.
 */
export async function forget(
	input: string,
): Promise<{ folder: string; changed: string[] }> {
	const folder = resolve(input);
	const target = await realpath(folder).catch(() => null);
	const changed: string[] = [];
	if (target !== null && repositoryRoot(target) === target)
		if (setSynced(target, false)) changed.push('epicenter.synced unset');
	return { folder, changed };
}
