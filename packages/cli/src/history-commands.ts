/**
 * `status`, `history`, `save-version`, and `sync`: a folder's history over
 * the system `git` (ADR-0559). Each is a thin wrapper over `runHistory` in
 * `@epicenter/folder/bun`, the engine a desktop page's history runs in: the
 * shell runs these commands with `--json` for the page, one child per
 * operation, and reads the one reply line.
 *
 * `sync` that needs choices exits 1 and records its attempt under the
 * folder's `.git/epicenter`. `sync --resolve <file>` settles it: the file
 * (or `-`, standard input) holds `{"attempt": "<id>", "choices": {...}}`,
 * one choice per conflict ID, and the conflicts are merged again from the
 * commits the attempt recorded.
 *
 * A sync that connects a remote also configures the repository for
 * `epicenter merge-driver`, so terminal merges use the same merge.
 *
 * Who commits comes from the folder's Git configuration, then
 * `EPICENTER_AUTHOR_NAME` and `EPICENTER_AUTHOR_EMAIL`, which the shell sets
 * to the folder's fallback author. `EPICENTER_BRANCH` names the branch
 * (`main` by default), and `EPICENTER_FOLDER_KIND=application` marks an
 * application's own folder, which may get a repository inside another
 * repository's working tree.
 */

import {
	decodeHistory,
	encodeHistory,
	GitMissingError,
	type HistoryReply,
	type HistoryRequest,
	type HistoryResults,
	historyExitCode,
	runHistory,
	type UrlCredential,
} from '@epicenter/folder/bun';
import { EXIT, fail, writeErr, writeJson, writeOut } from './output.ts';

type Options = Record<string, string | true>;

/** The author for commits where the folder's Git configuration names none. */
function author() {
	return {
		name: process.env.EPICENTER_AUTHOR_NAME || 'Epicenter',
		email: process.env.EPICENTER_AUTHOR_EMAIL || 'epicenter@localhost',
	};
}

/** Read all of standard input as one JSON object, or `undefined` when empty. */
async function stdinObject(): Promise<Record<string, unknown> | undefined> {
	const text = (await Bun.stdin.text()).trim();
	if (text === '') return undefined;
	const value: unknown = decodeHistory(text);
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		throw new Error('standard input must hold one JSON object');
	return value as Record<string, unknown>;
}

function credentialOf(value: unknown): UrlCredential | undefined {
	if (value === undefined || value === null) return undefined;
	const { url, username, password } = value as Record<string, unknown>;
	if (
		typeof url !== 'string' ||
		typeof username !== 'string' ||
		typeof password !== 'string'
	)
		throw new Error(
			'a credential is {"url", "username", "password"}, each a string',
		);
	return { url, username, password };
}

/** The request `sync`'s options and input make. */
async function syncRequest(options: Options): Promise<HistoryRequest> {
	if (options.to !== undefined)
		throw new Error(
			'epicenter sync --to is not built yet; see ADR-0558 (docs/adr/0558-the-epicenter-cli-groups-only-its-app-and-auth-commands.md)',
		);
	const resolve = options.resolve;
	const fromStdin =
		resolve === '-' || options['credential-stdin'] === true
			? await stdinObject()
			: undefined;
	const credential = credentialOf(
		options['credential-stdin'] === true ? fromStdin?.credential : undefined,
	);
	if (typeof resolve === 'string') {
		const answer =
			resolve === '-'
				? fromStdin
				: decodeHistory<Record<string, unknown>>(
						await Bun.file(resolve).text(),
					);
		const attempt = answer?.attempt;
		if (typeof attempt !== 'string' || answer?.choices === undefined)
			throw new Error(
				`${resolve === '-' ? 'standard input' : resolve} must hold {"attempt": "<id>", "choices": {...}}, as the last sync printed them`,
			);
		return { op: 'settle', attempt, choices: answer.choices, credential };
	}
	return {
		op: 'sync',
		connect: typeof options.remote === 'string' ? options.remote : undefined,
		allowUnrelatedHistories: options['allow-unrelated'] === true,
		credential,
	};
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
		case 'sync':
		case 'settle': {
			const { data, error } = reply.result as HistoryResults['sync'];
			if (error === null)
				return data.kind === 'synced'
					? `Synced at ${short(data.head)}.`
					: `Saved at ${short(data.head)}; the remote does not hold it yet${data.push?.status === 'failed' ? `: ${data.push.error}` : ''}.`;
			if (error.name !== 'NeedsChoices') return error.message;
			const { attempt } = error;
			return [
				`${error.message}. Nothing conflicted was written or sent.`,
				...attempt.conflicts.map(
					(conflict) =>
						`  ${conflict.id}  ${conflict.kind} ${conflict.path}${'field' in conflict ? ` ${conflict.field}` : 'key' in conflict ? ` ${conflict.key}` : ''}`,
				),
				`Write {"attempt": "${attempt.id}", "choices": {"<id>": {"kind": "take", "side": "local" | "incoming"}, ...}} to a file and run epicenter sync <dir> --resolve <file>.`,
			].join('\n');
		}
	}
}

/** Run one history command and print its reply. */
export async function historyCommand(
	command: 'status' | 'history' | 'save-version' | 'sync',
	dir: string,
	options: Options,
	json: boolean,
): Promise<number> {
	let request: HistoryRequest;
	try {
		request = await requestOf(command, options);
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error), json);
	}
	let reply: HistoryReply<unknown>;
	try {
		reply = await runHistory(dir, request, {
			author: author(),
			application: process.env.EPICENTER_FOLDER_KIND === 'application',
			branch: process.env.EPICENTER_BRANCH || undefined,
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
