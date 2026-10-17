/**
 * `status`, `history`, `save-version`, and `sync`: a folder's history over
 * the system `git` (ADR-0559). Each is a thin wrapper over `runHistory` in
 * `@epicenter/folder/bun`, the engine a desktop page's history runs in: the
 * shell runs these commands with `--json` for the page, one child per
 * operation, and reads the one reply line.
 *
 * `sync` asks nothing: what both sides changed merges into one commit
 * whose competing units go to this folder (ADR-0576).
 *
 * A sync that connects a remote also configures the repository for
 * `epicenter merge-driver`, so terminal merges use the same merge.
 *
 * Who commits comes from the folder's Git configuration, and otherwise is
 * `Epicenter <epicenter@localhost>`. History is recorded on `main`. An
 * application's own folder (`isApplicationFolder`) may get a repository
 * inside another repository's working tree; a data folder may not.
 */

import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { CONNECTIONS_FOLDER_ID } from '@epicenter/ai/connection-table';
import {
	encodeHistory,
	GitMissingError,
	type HistoryReply,
	type HistoryRequest,
	type HistoryResults,
	historyExitCode,
	runHistory,
} from '@epicenter/folder/bun';
import { resolveAppPaths } from './app-paths.ts';
import type { GrantKind } from './auth.ts';
import { EXIT, fail, writeErr, writeJson, writeOut } from './output.ts';

type Options = Record<string, string | true>;

/** Who commits where the folder's Git configuration names nobody. */
const AUTHOR = { name: 'Epicenter', email: 'epicenter@localhost' };

/**
 * Whether `dir` is an application's own folder, by the shell's rule
 * (`data_folders.rs`): directly under the Epicenter folder root and named
 * `so.epicenter` or the id of an app installed in `Apps/`. Any other folder
 * is a data folder.
 */
export async function isApplicationFolder(
	dir: string,
	paths = resolveAppPaths(),
): Promise<boolean> {
	const [resolved, folderRoot] = await Promise.all([
		realpath(dir).catch(() => undefined),
		realpath(paths.folderDir).catch(() => undefined),
	]);
	if (resolved === undefined || dirname(resolved) !== folderRoot) return false;
	const name = basename(resolved);
	if (name === CONNECTIONS_FOLDER_ID) return true;
	return stat(join(paths.appsDir, name)).then(
		(found) => found.isDirectory(),
		() => false,
	);
}

/**
 * The request `sync`'s options make. `--to` connects the folder
 * first, and the merge driver follows from connecting: `<namespace>/<name>`
 * names a hosted repository on this deployment (ADR-0546), whose remote is
 * `<git origin>/<namespace>/<name>.git`; anything else is the remote's URL,
 * as the desktop app passes it. A sync to any of this deployment's hosted
 * repositories carries the grant's token (`hostedCredentials`), asked for
 * with the remote the folder's history reads.
 */
async function syncRequest(options: Options): Promise<HistoryRequest> {
	let connect: string | undefined;
	if (options.to !== undefined) {
		if (typeof options.to !== 'string')
			throw new Error('--to takes <namespace>/<name> or a URL');
		const [{ authContext }, { remoteFor }] = await Promise.all([
			import('./auth.ts'),
			import('./repository-commands.ts'),
		]);
		connect = remoteFor(authContext(), options.to);
	}
	return {
		op: 'sync',
		connect,
		allowUnrelatedHistories: options['allow-unrelated'] === true,
	};
}

/**
 * `--app-local`, a JSON array of the `local` patterns of an app reading a
 * folder that is not its own (ADR-0583), as the desktop shell passes them.
 */
function appLocalOf(options: Options): string[] | undefined {
	const given = options['app-local'];
	if (given === undefined) return undefined;
	const patterns: unknown =
		typeof given === 'string' ? JSON.parse(given) : given;
	if (
		!Array.isArray(patterns) ||
		!patterns.every((pattern) => typeof pattern === 'string')
	)
		throw new Error('--app-local takes a JSON array of patterns');
	return patterns;
}

/** The request each command line makes. */
async function requestOf(
	command: 'status' | 'history' | 'save-version' | 'sync',
	options: Options,
): Promise<HistoryRequest> {
	switch (command) {
		case 'status':
			return { op: 'status' };
		case 'history': {
			const depth = options.depth === undefined ? 20 : Number(options.depth);
			if (!Number.isInteger(depth) || depth < 1)
				throw new Error('--depth takes a whole number of versions, at least 1');
			return { op: 'log', depth };
		}
		case 'save-version':
			return {
				op: 'saveVersion',
				message:
					typeof options.message === 'string' ? options.message : undefined,
			};
		case 'sync':
			return syncRequest(options);
	}
}

const short = (oid: string | undefined) => oid?.slice(0, 7) ?? 'none';

/** What a reply says, for a person. */
function describeReply(
	request: HistoryRequest,
	reply: HistoryReply<unknown>,
): string {
	const { state } = reply;
	switch (request.op) {
		case 'status': {
			const { data, error } = reply.result as HistoryResults['status'];
			if (error !== null) return error.message;
			const sync = state.sync;
			return [
				`On ${state.branch} at ${short(data.head)}`,
				data.changes.length === 0
					? 'No changes since the last version.'
					: `${data.changes.length} changed since the last version:\n${data.changes
							.map((change) => `  ${change.kind} ${change.path}`)
							.join('\n')}`,
				state.remote === undefined
					? 'No remote.'
					: `Remote ${state.remote.url}${sync === undefined ? '' : `: ${sync.ahead} ahead, ${sync.behind} behind`}.`,
			].join('\n');
		}
		case 'log': {
			const { data, error } = reply.result as HistoryResults['log'];
			if (error !== null) return error.message;
			if (data.length === 0) return 'No versions yet.';
			return data
				.map(
					(commit) =>
						`${short(commit.oid)} ${new Date(commit.author.timestamp * 1000).toISOString()} ${commit.author.name}  ${commit.message.split('\n')[0]}`,
				)
				.join('\n');
		}
		case 'saveVersion': {
			const outcome = reply.result as HistoryResults['saveVersion'];
			switch (outcome.status) {
				case 'committed':
					return `Saved version ${short(outcome.oid)}: ${outcome.message}`;
				case 'unchanged':
					return 'Nothing changed since the last version.';
				case 'blocked':
					return `No version was saved: ${outcome.reason}`;
				case 'failed':
				case 'unconfirmed':
					return `No version was saved: ${outcome.error}`;
				default:
					return `No version was saved (${outcome.status}).`;
			}
		}
		case 'sync': {
			const { data, error } = reply.result as HistoryResults['sync'];
			if (error !== null) return error.message;
			return data.kind === 'synced'
				? `Synced at ${short(data.head)}.`
				: `Saved at ${short(data.head)}; the remote does not hold it yet${data.push?.status === 'failed' ? `: ${data.push.error}` : ''}.`;
		}
	}
}

/** Run one history command and print its reply. */
export async function historyCommand(
	command: 'status' | 'history' | 'save-version' | 'sync',
	dir: string,
	options: Options,
	json: boolean,
	grant: GrantKind,
): Promise<number> {
	let request: HistoryRequest;
	let appLocal: string[] | undefined;
	try {
		request = await requestOf(command, options);
		appLocal = appLocalOf(options);
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error), json);
	}
	let reply: HistoryReply<unknown>;
	try {
		reply = await runHistory(dir, request, {
			author: AUTHOR,
			application: await isApplicationFolder(dir),
			appLocal,
			credentials: async (url, signal) => {
				const [{ authContext }, { hostedCredentials }] = await Promise.all([
					import('./auth.ts'),
					import('./repository-commands.ts'),
				]);
				return hostedCredentials(authContext(), grant)(url, signal);
			},
		});
	} catch (error) {
		if (error instanceof GitMissingError) {
			if (json)
				writeJson({
					error: 'GitMissing',
					message: error.message,
					install: error.install,
				});
			else writeErr(error.message);
			return EXIT.unusable;
		}
		return fail(error instanceof Error ? error.message : String(error), json);
	}
	// Connecting makes the folder's repository merge by kind under plain
	// `git merge` and `git pull` too (ADR-0566). A failure here leaves Git's
	// text merge, which loses nothing, so it is said and not fatal.
	if (request.op === 'sync' && request.connect !== undefined)
		try {
			const { configureMergeDriver } = await import('./merge-driver.ts');
			await configureMergeDriver(dir);
		} catch (error) {
			writeErr(
				`git merge will merge this folder's files as text: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	if (json) process.stdout.write(`${encodeHistory(reply)}\n`);
	else writeOut(describeReply(request, reply));
	return historyExitCode(reply) === 0 ? EXIT.ok : EXIT.finding;
}
