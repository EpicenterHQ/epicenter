/**
 * The handlers for `init`, `sync`, `clone`, `forget`, `status`, and the
 * hidden `merge-driver` (decision 39): output and exit codes over the
 * verbs in this directory.
 *
 * `sync --json` prints one line per folder per round, `{"sync": {...}}`
 * (`SyncResult`), which the desktop app reads. Exit codes for sync: 0 every
 * folder synced, 1 a round to run again (a lock, the network, the remote
 * still moving), 2 a folder stopped for a person or agent.
 *
 * A hosted remote on this deployment's Git origin gets the grant's token as
 * a header on each transfer (`hostedCredentials`); any other remote uses
 * the person's own Git credentials.
 */

import { existsSync, type FSWatcher, watch as watchDirectory } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
	parseRepositoryPath,
	parseRepositoryUrl,
	repositoryUrl,
} from '@epicenter/constants/repositories';
import { resolveAppPaths } from '../app-paths.ts';
import type { GrantKind } from '../auth.ts';
import { EXIT, fail, writeErr, writeJson, writeOut } from '../output.ts';
import type { RemoteCredential } from './git.ts';
import { mergeDriver } from './merge-driver.ts';
import { type InitOptions, Refused, registeredFolders } from './setup.ts';
import type { SyncResult } from './sync.ts';

type Options = Record<string, string | true>;

/** The grant's token for a remote on this deployment's Git origin; none for any other. */
function credentialFor(grant: GrantKind) {
	return async (url: string): Promise<RemoteCredential | undefined> => {
		if (!url.startsWith('https://')) return undefined;
		const [{ authContext }, { hostedCredentials }, { basicAuthorization }] =
			await Promise.all([
				import('../auth.ts'),
				import('../repository-commands.ts'),
				import('@epicenter/folder/bun'),
			]);
		const credential = await hostedCredentials(authContext(), grant)(
			url,
			AbortSignal.timeout(60_000),
		);
		return credential && { url, authorization: basicAuthorization(credential) };
	};
}

/** What init sets in each clone: the grant's credential and the deployment's helper. */
async function initOptions(grant: GrantKind): Promise<InitOptions> {
	const { gitHelperOrigin, resolveDeployment, shellQuote } = await import(
		'../auth.ts'
	);
	return {
		credential: credentialFor(grant),
		helper: {
			origin: gitHelperOrigin(resolveDeployment()),
			command: `!${shellQuote(resolveAppPaths().commandLink)} auth git-credential`,
		},
	};
}

function reportSetup(
	verb: 'init' | 'cloned' | 'forget',
	value: {
		readonly folder: string;
		readonly changed: string[];
		readonly warnings?: string[];
		readonly url?: string;
	},
	json: boolean,
) {
	if (json) writeJson({ [verb]: value });
	else
		writeOut(
			`${value.folder}: ${value.changed.length === 0 ? 'nothing to do' : value.changed.join('; ')}`,
		);
	if (!json)
		for (const warning of value.warnings ?? []) writeErr(`warning: ${warning}`);
}

/** `epicenter init [<dir>] [--enclosing-ok]`. */
export async function initCommand(
	dir: string | undefined,
	options: Options,
	json: boolean,
	grant: GrantKind,
) {
	const { init } = await import('./setup.ts');
	try {
		const initialized = await init(dir ?? '.', {
			...(await initOptions(grant)),
			allowEnclosing: options['enclosing-ok'] === true,
		});
		reportSetup('init', initialized, json);
		return EXIT.ok;
	} catch (error) {
		if (error instanceof Refused)
			return fail(`refused: ${error.message}`, json);
		throw error;
	}
}

/** `epicenter forget [<dir>]`. */
export async function forgetCommand(dir: string | undefined, json: boolean) {
	const { forget } = await import('./setup.ts');
	reportSetup('forget', await forget(dir ?? '.'), json);
	return EXIT.ok;
}

/** `epicenter clone <namespace>/<name> | <url> | <path> [<dir>]`. */
export async function cloneCommand(
	source: string,
	dir: string | undefined,
	json: boolean,
	grant: GrantKind,
) {
	const [{ clone, localSource }, { resolveDeployment }] = await Promise.all([
		import('./clone.ts'),
		import('../auth.ts'),
	]);
	const git = resolveDeployment().audiences.git;
	const hosted = parseRepositoryPath(source);
	const named =
		localSource(source) ??
		(hosted !== undefined
			? { url: repositoryUrl(git, hosted), name: hosted.name }
			: URL.canParse(source)
				? {
						url: source,
						name:
							parseRepositoryUrl(git, source)?.name ??
							basename(new URL(source).pathname, '.git'),
					}
				: undefined);
	if (named === undefined)
		return fail(
			`'${source}' is neither <namespace>/<name>, a URL, nor a path to a repository`,
			json,
		);
	const target = resolve(dir ?? join(resolveAppPaths().folderDir, named.name));
	try {
		const cloned = await clone(named, target, await initOptions(grant));
		reportSetup('cloned', { url: named.url, ...cloned }, json);
		return EXIT.ok;
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error), json);
	}
}

/** `epicenter status [<dir>]`. */
export async function statusCommand(dir: string | undefined, json: boolean) {
	const { folderStatus } = await import('./status.ts');
	const status = await folderStatus(dir ?? '.');
	if (status === null)
		return fail(
			`${resolve(dir ?? '.')} is not in a Git repository; run epicenter init`,
			json,
		);
	if (json) {
		writeJson({ status });
		return EXIT.ok;
	}
	writeOut(
		[
			`${status.folder} on ${status.branch ?? 'a detached HEAD'} at ${status.head?.slice(0, 7) ?? 'no commit yet'}`,
			status.adopted && status.registered
				? 'Registered for sync.'
				: `Not synced: run epicenter init ${status.folder}.`,
			status.changes.length === 0
				? 'No changes since the last sync.'
				: `${status.changes.length} changed since the last sync:\n${status.changes.map((c) => `  ${c.status} ${c.path}`).join('\n')}`,
			status.remote === null
				? 'No remote.'
				: `Remote ${status.remote}${status.ahead === null ? ': not fetched yet' : `: ${status.ahead} ahead, ${status.behind} behind as of the last sync`}.`,
		].join('\n'),
	);
	return EXIT.ok;
}

const EXIT_OF = {
	synced: EXIT.ok,
	retry: EXIT.finding,
	stopped: EXIT.unusable,
} as const;

function reportSync(result: SyncResult, json: boolean) {
	if (json) {
		writeJson({ sync: result });
		return;
	}
	for (const note of result.notes) writeOut(`${result.folder}: ${note}`);
	if (result.status === 'synced')
		writeOut(`${result.folder}: in sync at ${result.head?.slice(0, 7)}`);
	else
		writeErr(
			`${result.folder}: ${result.status === 'retry' ? 'not synced, run again' : 'stopped'}: ${result.message}`,
		);
}

/** `epicenter sync [<dir>] [--watch]`: one folder, or every registered one. */
export async function syncCommand(
	dir: string | undefined,
	options: Options,
	json: boolean,
	grant: GrantKind,
) {
	const [{ syncFolder }, { endGitCommands }, { onStop }] = await Promise.all([
		import('./sync.ts'),
		import('@epicenter/folder/bun'),
		import('../stop.ts'),
	]);
	// When the shell ends this process, every git it started ends too (ADR-0559).
	onStop(endGitCommands);
	const credential = credentialFor(grant);
	const folders = async () =>
		dir === undefined ? registeredFolders() : [resolve(dir)];
	const roundOf = async () => {
		let exit: number = EXIT.ok;
		for (const folder of await folders()) {
			const result = await syncFolder(folder, { credential });
			reportSync(result, json);
			exit = Math.max(exit, EXIT_OF[result.status]);
		}
		return exit;
	};

	if (options.watch !== true) {
		if ((await folders()).length === 0) {
			writeErr('No folder is registered for sync; run epicenter init <dir>.');
			return EXIT.ok;
		}
		return roundOf();
	}
	const interval =
		options.interval === undefined ? 30 : Number(options.interval);
	if (!(interval > 0))
		return fail('--interval takes a number of seconds above 0', json);
	return watch(folders, roundOf, interval);
}

/**
 * Run a round now, then again whenever a watched folder changes (half a
 * second after the first change) or `interval` seconds pass, until a stop
 * signal ends the process. Changes under `.git`, and those made while a
 * round runs, do not start one.
 */
async function watch(
	folders: () => Promise<string[]>,
	roundOf: () => Promise<number>,
	interval: number,
): Promise<never> {
	const watchers = new Map<string, FSWatcher>();
	let busy = false;
	let wake = () => {};
	for (;;) {
		for (const folder of await folders())
			if (!watchers.has(folder) && existsSync(folder))
				watchers.set(
					folder,
					watchDirectory(folder, { recursive: true }, (_event, name) => {
						if (busy) return;
						const path = String(name ?? '');
						if (path === '.git' || path.startsWith('.git/')) return;
						wake();
					}),
				);
		busy = true;
		await roundOf();
		busy = false;
		await new Promise<void>((done) => {
			const timer = setTimeout(done, interval * 1000);
			wake = () => {
				clearTimeout(timer);
				setTimeout(done, 500);
			};
		});
		wake = () => {};
	}
}

/** `epicenter merge-driver %O %A %B %P`, which Git runs. */
export const mergeDriverCommand = ([base, ours, theirs, path]: string[]) =>
	mergeDriver(base as string, ours as string, theirs as string, path);
