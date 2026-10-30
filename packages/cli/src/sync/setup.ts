/**
 * `epicenter init` and `epicenter forget`: put a data folder under
 * Epicenter's history, or take it out (decisions 36, 39, 41).
 *
 * `init` is set-up-or-repair and idempotent: each step checks first, changes
 * only what is missing or wrong, and says what it changed. A folder inside
 * another repository's working tree is refused unless the caller passes
 * `allowEnclosing` (`--enclosing-ok`): spike 7's first run adopted
 * `~/.claude` that way and committed its credentials. The repository init
 * adopts is recorded as `epicenter.root` in its local configuration, and
 * sync refuses any repository without it.
 *
 * Registration is like `git maintenance register`: the multi-valued
 * `epicenter.folder` in the person's global Git configuration lists the
 * folders `epicenter sync` (no path) and `sync --watch` keep in sync.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
	REPOSITORY_ATTRIBUTES,
	REPOSITORY_IGNORE,
} from '@epicenter/definition/contract';
import { resolveAppPaths } from '../app-paths.ts';
import { config, configAll, git, must, type RemoteCredential } from './git.ts';
import { withEpicenterBlock } from './managed-block.ts';

/** Init would adopt a repository the folder sits inside, and was not told to. */
export class Refused extends Error {}

/** One argument for `sh`, single-quoted. */
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

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
	/** Adopt a repository the folder sits inside (`--enclosing-ok`). */
	readonly allowEnclosing?: boolean;
	/** The credential for a remote, asked for by its URL, to pull LFS bytes. */
	readonly credential?: (url: string) => Promise<RemoteCredential | undefined>;
	/** `credential.<origin>.helper` to set per clone, when a deployment has one. */
	readonly helper?: { readonly origin: string; readonly command: string };
};

export type Initialized = {
	readonly folder: string;
	readonly repository: string;
	/** What init changed, in order; empty when nothing was missing. */
	readonly changed: string[];
	/** What init could not fix and the person should know. */
	readonly warnings: string[];
};

/** Set up or repair `input` for Epicenter sync. Throws `Refused` for an enclosing repository. */
export async function init(
	input: string,
	{ allowEnclosing = false, credential, helper }: InitOptions = {},
): Promise<Initialized> {
	await mkdir(resolve(input), { recursive: true });
	const folder = await realpath(resolve(input));
	const changed: string[] = [];
	const warnings: string[] = [];

	// 1. A repository, adopted only on purpose when it encloses the folder.
	const top = await repositoryRoot(folder);
	if (
		top !== null &&
		top !== folder &&
		(await config(folder, 'epicenter.root')) !== top &&
		!allowEnclosing
	)
		throw new Refused(
			`${folder} is inside the existing repository ${top}. epicenter sync would pull and push that whole repository (it commits only this folder). Pass --enclosing-ok to adopt it on purpose.`,
		);
	if (top === null) {
		await must(folder, ['init', '-q', '-b', 'main']);
		changed.push('git init');
	}
	const root = (await repositoryRoot(folder)) as string;
	if ((await config(folder, 'epicenter.root')) !== root) {
		await must(folder, ['config', '--local', 'epicenter.root', root]);
		changed.push(`epicenter.root = ${root}`);
	}

	// 2. Epicenter's blocks of the folder's committed attributes and ignore rules.
	const managed = [
		['.gitattributes', REPOSITORY_ATTRIBUTES],
		['.gitignore', REPOSITORY_IGNORE],
	] as const;
	for (const [name, block] of managed) {
		const path = join(folder, name);
		const current = existsSync(path) ? await readFile(path, 'utf8') : null;
		const wanted = withEpicenterBlock(current, block);
		if (current !== wanted) {
			await writeFile(path, wanted);
			changed.push(`${name} written`);
		}
	}
	const names = managed.map(([name]) => name);
	const pending = (
		await must(folder, ['status', '--porcelain', '--', ...names])
	).trim();
	if (pending !== '') {
		const touched = names.filter((name) => pending.includes(name));
		await must(folder, ['add', '--', ...touched]);
		// Path-limited: commits only these files, whatever else is staged.
		await must(
			folder,
			[
				'commit',
				'-q',
				'-m',
				'epicenter: attributes and ignore rules',
				'--',
				...touched,
			],
			{ env: await identity(folder) },
		);
		for (const name of touched) changed.push(`${name} committed`);
	}

	// 3. The per-clone merge driver.
	if ((await config(folder, 'merge.epicenter.driver')) !== driverCommand()) {
		await must(folder, [
			'config',
			'--local',
			'merge.epicenter.driver',
			driverCommand(),
		]);
		changed.push('merge.epicenter.driver set');
	}
	if ((await config(folder, 'merge.epicenter.name')) === null) {
		await must(folder, [
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
	const hooks = await hooksDirectory(folder);
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
		if ((await config(folder, key)) === null) missingConfig.push(key);
	if (missingHooks.length > 0 || missingConfig.length > 0) {
		const missing = [
			...missingConfig,
			...missingHooks.map((h) => `hooks/${h}`),
		];
		// The runner points `core.hooksPath` nowhere; LFS installs into the repository's own.
		const installed = await git(folder, [
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
			await must(folder, ['lfs', 'install', '--local', '--skip-repo']);
			changed.push(
				`git lfs install --local --skip-repo (missing: ${missing.join(', ')})`,
			);
			warnings.push(
				`LFS hooks were not installed, so a plain git push may not upload LFS bytes (epicenter sync does): ${installed.stderr.trim()}`,
			);
		}
	}

	// 5. Files checked out as pointers (a clone made without LFS) get their bytes.
	const pointers = (await git(folder, ['lfs', 'ls-files'])).stdout
		.split('\n')
		.filter((line) => / - /.test(line));
	if (pointers.length > 0) {
		const url = await config(folder, 'remote.origin.url');
		const pulled = await git(folder, ['lfs', 'pull'], {
			credential: url === null ? undefined : await credential?.(url),
		});
		if (pulled.code === 0)
			changed.push(
				`git lfs pull (${pointers.length} pointer file(s) replaced)`,
			);
		else warnings.push(`git lfs pull failed: ${pulled.stderr.trim()}`);
	}

	// 6. The Epicenter credential helper for this deployment's Git, per clone.
	if (helper !== undefined) {
		const key = `credential.${helper.origin}.helper`;
		const values = await configAll(folder, key);
		if (
			values.length !== 2 ||
			values[0] !== '' ||
			values[1] !== helper.command
		) {
			// An empty helper first clears the ones a broader configuration set.
			await must(folder, ['config', '--local', '--replace-all', key, '']);
			await must(folder, ['config', '--local', '--add', key, helper.command]);
			changed.push(`${key} set`);
		}
	}

	// 7. Registration.
	if (!(await registeredFolders()).includes(folder)) {
		await must(undefined, [
			'config',
			'--global',
			'--add',
			'epicenter.folder',
			folder,
		]);
		changed.push('registered in global epicenter.folder');
	}
	return { folder, repository: root, changed, warnings };
}

/**
 * Take `input` out of Epicenter's sync: unregister it, and drop
 * `epicenter.root` unless another registered folder shares its repository,
 * so a later sync refuses it until init runs again. The files, the
 * repository, and its history stay as they are.
 */
export async function forget(
	input: string,
): Promise<{ folder: string; changed: string[] }> {
	const folder = await realpath(resolve(input)).catch(() => resolve(input));
	const changed: string[] = [];
	const registered = await registeredFolders();
	if (registered.includes(folder)) {
		await must(undefined, [
			'config',
			'--global',
			'--fixed-value',
			'--unset-all',
			'epicenter.folder',
			folder,
		]);
		changed.push('unregistered from global epicenter.folder');
	}
	const root = existsSync(folder) ? await repositoryRoot(folder) : null;
	if (root !== null && (await config(folder, 'epicenter.root')) === root) {
		const others = await Promise.all(
			registered
				.filter((other) => other !== folder && existsSync(other))
				.map((other) => repositoryRoot(other)),
		);
		if (!others.includes(root)) {
			await must(folder, ['config', '--local', '--unset', 'epicenter.root']);
			changed.push('epicenter.root unset');
		}
	}
	return { folder, changed };
}
