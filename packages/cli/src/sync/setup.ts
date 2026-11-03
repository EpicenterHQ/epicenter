/**
 * `epicenter init` and `epicenter forget`: put a data folder under
 * Epicenter's history, or take it out (decisions 36, 39, 41).
 *
 * `init` is set-up-or-repair and idempotent: each step checks first, changes
 * only what is missing or wrong, and says what it changed. A folder inside a
 * `.git` or `.epicenter` directory is refused before anything is made
 * (`refuseReservedDirectory`). A folder inside
 * another repository's working tree is refused. Consent to sync is recorded
 * as `epicenter.synced = true` in the folder's local repository configuration.
 *
 * Registration is like `git maintenance register`: the multi-valued
 * `epicenter.folder` in the person's global Git configuration lists the
 * folders `epicenter sync` (no path) and `sync --watch` keep in sync.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { REPOSITORY_ATTRIBUTES } from '@epicenter/definition/contract';
import { STATE_DIRECTORY } from '@epicenter/folder/bun';
import { resolveAppPaths } from '../app-paths.ts';
import { canonicalPath, isReservedDirectory } from './admission.ts';
import {
	type CredentialFor,
	config,
	configAll,
	git,
	must,
	shellQuote,
} from './git.ts';
import { REPOSITORY_IGNORE, withEpicenterBlock } from './managed-block.ts';
import { repositoryProblem } from './repository-state.ts';

/**
 * The folder is inside protected state or another repository.
 */
export class Refused extends Error {}

/**
 * Refuse protected paths after resolving links, before making anything there.
 */
export async function refuseReservedDirectory(input: string): Promise<void> {
	const canonical = await canonicalPath(input);
	if (isReservedDirectory(canonical))
		throw new Refused(
			`${canonical} is inside a .git or ${STATE_DIRECTORY} folder, which belong to Git and to Epicenter, so it cannot be a data folder.`,
		);
	const paths = resolveAppPaths();
	const data = await canonicalPath(paths.dataDir);
	const library = await canonicalPath(paths.folderDir);
	const holds = (holder: string, inner: string) =>
		inner === holder || inner.startsWith(`${holder}/`);
	if (holds(canonical, data) || holds(data, canonical))
		throw new Refused(`${canonical} overlaps Epicenter's application data.`);
	if (holds(canonical, library))
		throw new Refused(
			`${canonical} holds every Epicenter folder, so it cannot be one.`,
		);
}

/**
 * The merge driver Git runs for `*.md` (decision 42): the per-user command
 * link (`AppPaths.commandLink`, ADR-0566), which a Git started from the
 * Finder finds as well as one in a terminal, so moving the app breaks
 * nothing. Init repairs a clone whose driver names anything else.
 */
export const driverCommand = (link = resolveAppPaths().commandLink) =>
	`${shellQuote(link)} merge-driver %O %A %B %P`;

const LFS_HOOKS = ['pre-push', 'post-checkout', 'post-commit', 'post-merge'];
const LFS_CONFIG = [
	'filter.lfs.clean',
	'filter.lfs.smudge',
	'filter.lfs.process',
	'filter.lfs.required',
];

/** The folders registered for sync, as stored. */
export const registeredFolders = () =>
	configAll(undefined, 'epicenter.folder', '--global');

/** A registered spelling that currently points at `target`, if any. */
export async function registrationFor(
	registered: readonly string[],
	target: string,
): Promise<string | undefined> {
	for (const entry of registered) {
		if ((await realpath(entry).catch(() => null)) === target) return entry;
	}
	return undefined;
}

/** The top of the repository `folder` is in, links resolved, or null. */
export async function repositoryRoot(folder: string): Promise<string | null> {
	const top = await git(folder, ['rev-parse', '--show-toplevel']);
	return top.code === 0 ? realpath(top.stdout.trim()) : null;
}

/** The hooks directory LFS installs into: the repository's own, whatever `core.hooksPath` says. */
async function hooksDirectory(folder: string) {
	const common = await must(folder, ['rev-parse', '--git-common-dir']);
	return join(resolve(folder, common.trim()), 'hooks');
}

/**
 * Environment that names a committer where the person's Git configuration
 * names none, so a first commit on a fresh computer still lands.
 */
export async function identity(cwd: string): Promise<Record<string, string>> {
	const [name, email] = await Promise.all([
		git(cwd, ['config', '--get', 'user.name']),
		git(cwd, ['config', '--get', 'user.email']),
	]);
	return {
		...(name.code === 0
			? {}
			: { GIT_AUTHOR_NAME: 'Epicenter', GIT_COMMITTER_NAME: 'Epicenter' }),
		...(email.code === 0
			? {}
			: {
					GIT_AUTHOR_EMAIL: 'epicenter@localhost',
					GIT_COMMITTER_EMAIL: 'epicenter@localhost',
				}),
	};
}

export type InitOptions = {
	/** The token for a remote, asked for by its URL, to pull LFS bytes. */
	readonly credential?: CredentialFor;
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
	{ credential }: InitOptions = {},
): Promise<Initialized> {
	await refuseReservedDirectory(input);
	const folder = resolve(input);
	await mkdir(folder, { recursive: true });
	const target = await realpath(folder);
	const changed: string[] = [];
	const warnings: string[] = [];

	// 1. The folder must be its own repository.
	const top = await repositoryRoot(target);
	if (top !== null && top !== target)
		throw new Refused(
			`${folder} is inside the existing repository ${top}. Move it outside that repository, then run epicenter init ${folder} again.`,
		);
	if (top === null) {
		await must(target, ['init', '-q', '-b', 'main']);
		changed.push('git init');
	}
	const root = (await repositoryRoot(target)) as string;
	const problem = await repositoryProblem(root);
	if (problem !== null) throw new Refused(problem);
	if ((await config(target, 'epicenter.synced')) !== 'true') {
		await must(target, ['config', '--local', 'epicenter.synced', 'true']);
		changed.push('epicenter.synced = true');
	}
	if ((await config(target, 'epicenter.root')) !== null) {
		await must(target, ['config', '--local', '--unset-all', 'epicenter.root']);
		changed.push('epicenter.root unset');
	}

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
	const names = managed.map(([name]) => name);
	const pending = (
		await must(target, ['status', '--porcelain', '--', ...names])
	).trim();
	if (pending !== '') {
		const touched = names.filter((name) => pending.includes(name));
		await must(target, ['add', '--', ...touched]);
		// Path-limited: commits only these files, whatever else is staged.
		await must(
			target,
			[
				'commit',
				'-q',
				'-m',
				'epicenter: attributes and ignore rules',
				'--',
				...touched,
			],
			{ env: await identity(target) },
		);
		for (const name of touched) changed.push(`${name} committed`);
	}

	// 3. The per-clone merge driver.
	if ((await config(target, 'merge.epicenter.driver')) !== driverCommand()) {
		await must(target, [
			'config',
			'--local',
			'merge.epicenter.driver',
			driverCommand(),
		]);
		changed.push('merge.epicenter.driver set');
	}
	if ((await config(target, 'merge.epicenter.name')) === null) {
		await must(target, [
			'config',
			'--local',
			'merge.epicenter.name',
			'Epicenter note merge',
		]);
		changed.push('merge.epicenter.name set');
	}
	if (!existsSync(resolveAppPaths().commandLink))
		warnings.push(
			`${resolveAppPaths().commandLink}, the merge driver's command, does not exist yet: run epicenter install-command`,
		);

	// 4. LFS filters, and hooks for a person's own git push, local to this clone.
	const hooks = await hooksDirectory(target);
	const missingHooks: string[] = [];
	for (const hook of LFS_HOOKS) {
		const file = join(hooks, hook);
		if (
			!existsSync(file) ||
			!(await readFile(file, 'utf8')).includes('git lfs')
		)
			missingHooks.push(hook);
	}
	const missingConfig: string[] = [];
	for (const key of LFS_CONFIG)
		if ((await config(target, key)) === null) missingConfig.push(key);
	if (missingHooks.length > 0 || missingConfig.length > 0) {
		const missing = [
			...missingConfig,
			...missingHooks.map((h) => `hooks/${h}`),
		];
		// The runner points `core.hooksPath` nowhere; LFS installs into the repository's own.
		const installed = await git(target, [
			'-c',
			`core.hooksPath=${hooks}`,
			'lfs',
			'install',
			'--local',
		]);
		if (installed.code === 0)
			changed.push(`git lfs install --local (missing: ${missing.join(', ')})`);
		else {
			// A hook of the person's own stands where LFS's would go: keep it, set the filters.
			await must(target, ['lfs', 'install', '--local', '--skip-repo']);
			changed.push(
				`git lfs install --local --skip-repo (missing: ${missing.join(', ')})`,
			);
			warnings.push(
				`LFS hooks were not installed, so a plain git push may not upload LFS bytes (epicenter sync does): ${installed.stderr.trim()}`,
			);
		}
	}

	// 5. Files checked out as pointers (a clone made without LFS) get their bytes.
	const pointers = (await git(target, ['lfs', 'ls-files'])).stdout
		.split('\n')
		.filter((line) => / - /.test(line));
	if (pointers.length > 0) {
		const url = await config(target, 'remote.origin.url');
		const pulled = await git(target, ['lfs', 'pull'], {
			credential: url === null ? undefined : await credential?.(url),
		});
		if (pulled.code === 0)
			changed.push(
				`git lfs pull (${pointers.length} pointer file(s) replaced)`,
			);
		else warnings.push(`git lfs pull failed: ${pulled.stderr.trim()}`);
	}

	// 6. Registration.
	const registered = await registeredFolders();
	const existing = await registrationFor(registered, target);
	if (folder !== target && registered.includes(target)) {
		if (!registered.includes(folder))
			await must(undefined, [
				'config',
				'--global',
				'--add',
				'epicenter.folder',
				folder,
			]);
		await must(undefined, [
			'config',
			'--global',
			'--fixed-value',
			'--unset-all',
			'epicenter.folder',
			target,
		]);
		changed.push('registered link in global epicenter.folder');
	} else if (!registered.includes(folder) && existing === undefined) {
		await must(undefined, [
			'config',
			'--global',
			'--add',
			'epicenter.folder',
			folder,
		]);
		changed.push('registered in global epicenter.folder');
	} else if (!registered.includes(folder) && existing !== undefined) {
		warnings.push(`already registered as ${existing}`);
	}
	return { folder, repository: root, changed, warnings };
}

/**
 * Take `input` out of Epicenter's sync: unregister it, and drop
 * `epicenter.synced` unless another registered path shares its repository,
 * so a later sync refuses it until init runs again. The files, the
 * repository, and its history stay as they are.
 */
export async function forget(
	input: string,
): Promise<{ folder: string; changed: string[] }> {
	const folder = resolve(input);
	const target = await realpath(folder).catch(() => null);
	const changed: string[] = [];
	const registered = await registeredFolders();
	const exact = [...new Set(registered.filter((entry) => entry === folder))];
	const matches =
		exact.length > 0
			? exact
			: target === null
				? []
				: [...new Set(registered.filter((entry) => entry === target))];
	if (matches.length === 0 && target !== null) {
		const alias = await registrationFor(registered, target);
		if (alias !== undefined) matches.push(alias);
	}
	for (const entry of matches) {
		await must(undefined, [
			'config',
			'--global',
			'--fixed-value',
			'--unset-all',
			'epicenter.folder',
			entry,
		]);
		changed.push('unregistered from global epicenter.folder');
	}
	const root = target === null ? null : await repositoryRoot(target);
	if (root !== null && root === target) {
		const others = await Promise.all(
			registered
				.filter((other) => !matches.includes(other) && existsSync(other))
				.map((other) => realpath(other).catch(() => null)),
		);
		if (!others.includes(target)) {
			for (const key of ['epicenter.synced', 'epicenter.root']) {
				if ((await config(target, key)) === null) continue;
				await must(target, ['config', '--local', '--unset-all', key]);
				changed.push(`${key} unset`);
			}
		}
	}
	return { folder, changed };
}
