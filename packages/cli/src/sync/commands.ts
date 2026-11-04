/**
 * The handlers for `init`, `connect`, `sync`, `clone`, `forget`, `status`, and the
 * hidden `merge-driver` (decision 39): output and exit codes over the
 * verbs in this directory.
 *
 * `sync --json` prints one line per folder per round, `{"sync": {...}}`
 * (`SyncResult`), which the desktop app reads. Exit codes for sync: 0 every
 * folder synced, 1 a round to run again (a lock, the network, the remote
 * still moving), 2 a folder stopped for a person or agent.
 *
 * A hosted `https` remote on this deployment's Git origin gets the grant's
 * token as a Bearer header on each transfer (`hostedCredentials`); any other
 * remote uses the person's own Git credentials. Init writes no credential
 * into a clone.
 */

import { type FSWatcher, watch as watchDirectory } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import {
	isRepositoryName,
	parseRepositoryPath,
	parseRepositoryUrl,
	repositoryUrl,
} from '@epicenter/constants/repositories';
import { isHiddenPath } from '@epicenter/definition/contract';
import type { GrantKind } from '../auth.ts';
import { EXIT, fail, writeErr, writeJson, writeOut } from '../output.ts';
import { type DiscoveredFolder, discoveredFolders } from './discovery.ts';
import type { CredentialFor } from './git.ts';
import { mergeDriver } from './merge-driver.ts';
import { Refused } from './setup.ts';
import type { FolderStatus } from './status.ts';
import type { SyncResult } from './sync.ts';

type Options = Record<string, string | true>;

/** The grant's token for a remote on this deployment's Git origin; none for any other. */
function credentialFor(grant: GrantKind): CredentialFor {
	return async (url) => {
		const [{ authContext }, { hostedCredentials }] = await Promise.all([
			import('../auth.ts'),
			import('../repository-commands.ts'),
		]);
		return hostedCredentials(authContext(), grant)(url);
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

/** `epicenter init [<dir>]`. */
export async function initCommand(
	dir: string | undefined,
	options: Options,
	json: boolean,
	grant: GrantKind,
) {
	const { init } = await import('./setup.ts');
	try {
		const initialized = await init(dir ?? '.', {
			name: typeof options.name === 'string' ? options.name : undefined,
			credential: credentialFor(grant),
		});
		reportSetup('init', initialized, json);
		return EXIT.ok;
	} catch (error) {
		if (error instanceof Refused)
			return fail(`refused: ${error.message}`, json);
		throw error;
	}
}

/** `epicenter connect <dir> <namespace>/<name> | <url> | <path>`. */
export async function connectCommand(
	dir: string,
	source: string,
	json: boolean,
	grant: GrantKind,
) {
	const named = await repositorySource(source, grant);
	if (named === undefined)
		return fail(
			`'${source}' is neither <namespace>/<name>, '~/name', nor a URL. Quote '~/name' or use file:// for a local repository.`,
			json,
		);
	const { connect } = await import('./connect.ts');
	try {
		const result = await connect(dir, named.url);
		if (json) writeJson({ connect: result });
		else
			writeOut(
				`${result.folder}: ${result.changed ? `origin = ${result.url}` : 'origin already set'}`,
			);
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
	options: Options,
	json: boolean,
	grant: GrantKind,
) {
	const { clone } = await import('./clone.ts');
	const named = await repositorySource(source, grant);
	if (named === undefined)
		return fail(
			`'${source}' is neither <namespace>/<name>, a URL, nor a path to a repository`,
			json,
		);
	try {
		const cloned = await clone(named, dir, {
			name: typeof options.name === 'string' ? options.name : undefined,
			credential: credentialFor(grant),
		});
		reportSetup('cloned', { url: named.url, ...cloned }, json);
		if (!json) {
			if (cloned.alreadyCloned)
				writeOut(`${cloned.folder}: already cloned from ${named.url}`);
			if (cloned.naming) writeOut(`${cloned.folder}: ${cloned.naming}`);
			for (const note of cloned.sync?.notes ?? [])
				writeOut(`${cloned.folder}: ${note}`);
			if (cloned.sync?.message)
				writeErr(`${cloned.folder}: ${cloned.sync.message}`);
		}
		return cloned.sync?.status === 'stopped'
			? EXIT.unusable
			: cloned.sync?.status === 'retry'
				? EXIT.finding
				: EXIT.ok;
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error), json);
	}
}

/** The repository spelling shared by clone and connect. */
async function repositorySource(source: string, grant?: GrantKind) {
	const [{ localSource }, { resolveDeployment }] = await Promise.all([
		import('./clone.ts'),
		import('../auth.ts'),
	]);
	const git = resolveDeployment().audiences.git;
	const hosted = parseRepositoryPath(source);
	const personalName = /^~\/(.+)$/.exec(source)?.[1];
	if (
		personalName !== undefined &&
		grant !== undefined &&
		isRepositoryName(personalName)
	) {
		const { personalNamespace } = await import('../repository-commands.ts');
		return {
			url: repositoryUrl(git, {
				namespace: await personalNamespace(grant),
				name: personalName,
			}),
			name: personalName,
		};
	}
	return (
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
				: undefined)
	);
}

/**
 * `epicenter status [<dir>]`: one folder, or without `<dir>` every
 * synced one, like `sync`. A folder that cannot be read
 * reports `{ folder, problem }` instead of failing the rest.
 */
export async function statusCommand(dir: string | undefined, json: boolean) {
	const { folderStatusOrProblem } = await import('./status.ts');
	if (dir === undefined) {
		const folders = await discoveredFolders();
		if (folders.length === 0 && !json)
			writeErr(
				'No synced folder found in the Epicenter library; run epicenter init <dir>.',
			);
		for (const { folder, problem } of folders) {
			const status =
				problem === undefined
					? await folderStatusOrProblem(folder)
					: { folder, problem };
			if (json) writeJson({ status });
			else if ('problem' in status)
				writeOut(`${folder}: unavailable: ${status.problem}`);
			else writeStatus(status);
		}
		return EXIT.ok;
	}
	const status = await folderStatusOrProblem(dir);
	if (json) writeJson({ status });
	else if ('problem' in status)
		writeOut(`${status.folder}: unavailable: ${status.problem}`);
	else writeStatus(status);
	return EXIT.ok;
}

function writeStatus(status: FolderStatus) {
	writeOut(
		[
			`${status.folder} on ${status.branch ?? 'a detached HEAD'} at ${status.head?.slice(0, 7) ?? 'no commit yet'}`,
			status.adopted
				? 'Synced for local history and sync.'
				: `Not synced: run epicenter init ${status.folder}.`,
			status.changes.length === 0
				? 'No changes since the last sync.'
				: `${status.changes.length} changed since the last sync:\n${status.changes.map((c) => `  ${c.status} ${c.path}`).join('\n')}`,
			status.remote === null
				? 'No origin; commits stay on this computer.'
				: `Remote ${status.remote}${status.ahead === null ? ': not fetched yet' : `: ${status.ahead} ahead, ${status.behind} behind as of the last sync`}.`,
		].join('\n'),
	);
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
		writeOut(
			`${result.folder}: ${result.notes.includes('no remote: committed locally') ? 'saved locally' : 'in sync'} at ${result.head?.slice(0, 7)}`,
		);
	else
		writeErr(
			`${result.folder}: ${result.status === 'retry' ? 'not synced, run again' : 'stopped'}: ${result.message}`,
		);
}

/** `epicenter sync [<dir>] [--watch]`: one folder, or every synced one. */
export async function syncCommand(
	dir: string | undefined,
	options: Options,
	json: boolean,
	grant: GrantKind,
) {
	const [
		{ syncFolder },
		{ endGitCommands },
		{
			finishBeforeExit,
			isStopping,
			onStop,
			ROUND_GRACE_MS,
			stopWhenStdinCloses,
		},
	] = await Promise.all([
		import('./sync.ts'),
		import('@epicenter/folder/bun'),
		import('../stop.ts'),
	]);
	// A stop lets the folder's round under way finish and begins no other, so
	// a merge is never cut off; then every git still running ends (ADR-0559).
	onStop(endGitCommands);
	const credential = credentialFor(grant);
	const folders = async (): Promise<DiscoveredFolder[]> =>
		dir === undefined ? discoveredFolders() : [{ folder: resolve(dir) }];
	const roundOf = async (entries: DiscoveredFolder[]) => {
		let exit: number = EXIT.ok;
		for (const { folder, problem } of entries) {
			if (isStopping()) break;
			if (problem !== undefined) {
				if (json)
					writeJson({
						sync: { folder, status: 'stopped', notes: [], message: problem },
					});
				else writeErr(`${folder}: unavailable: ${problem}`);
				continue;
			}
			const status = await finishBeforeExit(async () => {
				const result = await syncFolder(folder, { credential });
				reportSync(result, json);
				return result.status;
			}, ROUND_GRACE_MS).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				if (json)
					writeJson({
						sync: { folder, status: 'stopped', notes: [], message },
					});
				else writeErr(`${folder}: unavailable: ${message}`);
				return 'stopped' as const;
			});
			exit = Math.max(exit, EXIT_OF[status]);
		}
		return exit;
	};

	if (options.watch !== true) {
		const entries = await folders();
		if (entries.length === 0) {
			writeErr(
				'No synced folder found in the Epicenter library; run epicenter init <dir>.',
			);
			return EXIT.ok;
		}
		return roundOf(entries);
	}
	const interval =
		options.interval === undefined ? 30 : Number(options.interval);
	if (!(interval > 0))
		return fail('--interval takes a number of seconds above 0', json);
	// The desktop app holds stdin open while it lives, so its watch outlives
	// it, however it ends, by at most the round it finishes. A person's watch
	// may run with stdin closed.
	if (grant === 'desktop') stopWhenStdinCloses();
	return watch(folders, roundOf, interval);
}

/**
 * Run a round now, then again whenever a watched folder changes (half a
 * second after the first change) or `interval` seconds pass, until a stop
 * signal ends the process once the round under way has finished. A change
 * to a hidden path (`isHiddenPath`: `.git`, and every unfinished write in
 * `.epicenter`, such as a recording whose header is rewritten about once a
 * second, which a round never commits), and one made while a round runs,
 * does not start one.
 */
async function watch(
	folders: () => Promise<DiscoveredFolder[]>,
	roundOf: (entries: DiscoveredFolder[]) => Promise<number>,
	interval: number,
): Promise<never> {
	const watchers = new Map<string, { target: string; watcher: FSWatcher }>();
	let busy = false;
	let wake = () => {};
	for (;;) {
		const entries = await folders();
		const currentFolders = entries
			.filter((entry) => entry.problem === undefined)
			.map((entry) => entry.folder);
		for (const [folder, entry] of watchers) {
			if (currentFolders.includes(folder)) continue;
			entry.watcher.close();
			watchers.delete(folder);
		}
		for (const folder of currentFolders) {
			const target = await realpath(folder).catch(() => null);
			const current = watchers.get(folder);
			if (current?.target === target) continue;
			current?.watcher.close();
			watchers.delete(folder);
			if (target !== null)
				try {
					const watcher = watchDirectory(
						target,
						{ recursive: true },
						(_event, name) => {
							const path = String(name ?? '')
								.split(sep)
								.join('/');
							if (busy || isHiddenPath(path)) return;
							wake();
						},
					);
					watcher.on('error', (error) => {
						watcher.close();
						if (watchers.get(folder)?.watcher === watcher)
							watchers.delete(folder);
						writeErr(`${folder}: unavailable: ${error.message}`);
					});
					watchers.set(folder, {
						target,
						watcher,
					});
				} catch (error) {
					writeErr(
						`${folder}: unavailable: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
		}
		busy = true;
		await roundOf(entries);
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
