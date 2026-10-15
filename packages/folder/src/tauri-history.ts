/**
 * A desktop page's folder history, run by the `epicenter` CLI (ADR-0559).
 *
 * The page runs no Git. Each operation is one fixed command of the
 * Epicenter shell (`status`, `history`, `save_version`, `sync`, and
 * `settle_sync`), which runs one `epicenter` child over the folder this
 * window was granted and hands back the child's one reply line
 * (`history-wire.ts`). The child runs the same engine a Bun process does
 * (`runHistory`), over the system `git`. Two windows' children take turns
 * under the folder's history lock.
 *
 * Sync's review spans a person's decision (ADR-0514): a sync that needs
 * choices records its attempt under `.git/epicenter`, and `resolve` sends
 * only the attempt's ID and the choices, which a second child settles
 * against the commits the attempt recorded. The page never sends a
 * conflict's text back.
 *
 * What a sync wrote is reported once on the folder's change channel from
 * the reply's `landed` paths, as a page's own Sync is on every host
 * (ADR-0548). The shell's watcher hears the same files and the moved
 * history (`.git`) as well; at most that rereads a file twice.
 *
 * Status is the CLI's too, and the page holds what it last answered: the
 * query layer rereads it only when the change channel or a write of the
 * page's own marks it stale (ADR-0553).
 *
 * The finer Git steps (`push`, `fetch`, `pullFastForward`, `mergeIncoming`,
 * staging, `diff`) have no desktop command: they answer `Failed`, and Sync
 * is how a desktop folder exchanges history. A reload or a closed window
 * ends the children it started.
 */
import { invoke } from '@tauri-apps/api/core';
import { Err, type Result } from 'wellcrafted/result';
import type { DirectoryHistory } from './directory-adapter.js';
import { describe } from './errors.js';
import type { PathStatus } from './git/backend.js';
import { GitError, SyncError } from './git/errors.js';
import type {
	CommitAndPushResult,
	CommitOutcome,
	FetchOutcome,
	FilesObservation,
	GitSnapshot,
	History,
	MergeError,
	MergeOutcome,
	Observation,
	PullError,
	PullOutcome,
	PushOutcome,
	StagedCommit,
	SyncObservation,
} from './git/history.js';
import type { GitCredentials } from './git/http.js';
import type { CommitSummary } from './git/objects.js';
import { createPassRunner } from './git/runner.js';
import type {
	SyncAttempt,
	SyncChoices,
	SyncOptions,
	SyncOutcome,
} from './git/sync.js';
import {
	decodeHistory,
	encodeHistory,
	type GitMissingReply,
	type HistoryReply,
	type HistoryResults,
	type HistoryState,
	type UrlCredential,
} from './history-wire.js';

/** What the shell's history commands answer: how the child ended, and its reply line. */
type CliHistoryOutput = {
	readonly code: number;
	readonly reply: string | null;
	readonly stderr: string;
};

/** Why the shell did not run the child, or the child did not finish. */
type CliError =
	| { readonly name: 'NotGranted'; readonly grant: unknown }
	| { readonly name: 'Refused'; readonly message: string }
	| { readonly name: 'Failed'; readonly message: string };

/** The reply, or why there is none. */
type Answer<T> =
	| { readonly kind: 'reply'; readonly reply: HistoryReply<T> }
	| { readonly kind: 'missing'; readonly missing: GitMissingReply }
	| { readonly kind: 'failed'; readonly message: string };

function describeCliError(cause: unknown): string {
	if (typeof cause === 'string') return cause;
	if (typeof cause === 'object' && cause !== null) {
		const { name, message, grant } = cause as Partial<
			CliError & { grant: unknown; message: string }
		>;
		if (name === 'NotGranted')
			return `this window holds no grant for the folder: ${JSON.stringify(grant)}`;
		if (typeof message === 'string') return message;
	}
	return describe(cause);
}

/** Run one shell command and read the child's reply line. */
async function ask<T>(
	command: string,
	args: Record<string, unknown>,
): Promise<Answer<T>> {
	let output: CliHistoryOutput;
	try {
		output = await invoke<CliHistoryOutput>(command, args);
	} catch (cause) {
		return { kind: 'failed', message: describeCliError(cause) };
	}
	const line = output.reply;
	if (line === null)
		return {
			kind: 'failed',
			message:
				output.stderr.trim() ||
				`epicenter exited with ${output.code} and answered nothing`,
		};
	let value: unknown;
	try {
		value = decodeHistory(line);
	} catch {
		return { kind: 'failed', message: `epicenter answered ${line}` };
	}
	const { error } = value as { error?: unknown };
	if (error === 'GitMissing')
		return { kind: 'missing', missing: value as GitMissingReply };
	if (typeof error === 'string') return { kind: 'failed', message: error };
	return { kind: 'reply', reply: value as HistoryReply<T> };
}

const UNSUPPORTED =
	'runs only as part of Sync in the desktop app; Sync fetches, merges, and pushes in one step';

/**
 * The history of the folder this window was granted under `scope`, over
 * the shell's history commands. `credentials`, when the page holds a token,
 * is asked for the remote's URL before each sync, and the token crosses to
 * the child on its standard input, sent by Git only to an `https` remote.
 */
export function cliHistory({
	scope,
	branch,
	credentials,
}: {
	readonly scope: string;
	readonly branch: string;
	readonly credentials?: GitCredentials;
}): DirectoryHistory {
	return async ({ landed }) =>
		() =>
			createCliHistory({ scope, branch, credentials, landed });
}

function createCliHistory({
	scope,
	branch,
	credentials,
	landed,
}: {
	scope: string;
	branch: string;
	credentials?: GitCredentials;
	landed: (paths: readonly string[]) => void;
}): History {
	const closing = new AbortController();
	let clock = 0;
	let lastEdit = 0;
	let state: HistoryState = {
		branch,
		remote: undefined,
		files: undefined,
		sync: undefined,
		lastCommit: undefined,
		lastPush: undefined,
	};
	let files: Observation<FilesObservation> = {
		state: 'unknown',
		error: undefined,
	};
	let sync: Observation<SyncObservation> = {
		state: 'unknown',
		error: undefined,
	};
	let lastMerge: GitSnapshot['lastMerge'];
	const running = { commit: 0, merge: 0 };
	const admitted = new Set<Promise<unknown>>();
	const listeners = new Set<(snapshot: GitSnapshot) => void>();
	let snapshot: GitSnapshot;

	function emit() {
		snapshot = Object.freeze({
			branch: state.branch,
			remote: state.remote,
			files,
			sync,
			activity: {
				scan: { active: scanRunner.active },
				commit: { active: running.commit > 0 },
				push: { active: false },
				fetch: { active: false },
				pull: { active: false },
				merge: { active: running.merge > 0 },
			},
			lastCommit: state.lastCommit,
			lastPush: state.lastPush,
			lastFetch: undefined,
			lastPull: undefined,
			lastMerge,
			closed: closing.signal.aborted,
		});
		for (const listener of [...listeners])
			if (listeners.has(listener))
				try {
					listener(snapshot);
				} catch {
					// A subscriber that throws must not fail the operation.
				}
	}

	/** Take what a reply says the history knew, observed at `capturedAt`. */
	function observe(reply: HistoryReply<unknown>, capturedAt: number) {
		state = reply.state;
		const now = Date.now();
		if (reply.state.files !== undefined)
			files = {
				state: 'observed',
				value: reply.state.files,
				checkedAt: now,
				stale: lastEdit > capturedAt,
				error: undefined,
			};
		if (reply.state.sync !== undefined)
			sync = {
				state: 'observed',
				value: reply.state.sync,
				checkedAt: now,
				stale: false,
				error: undefined,
			};
		if (reply.landed.length > 0) landed(reply.landed);
	}

	/** Admit one operation until it settles; `close()` waits for it. */
	function admit<T>(work: () => Promise<T>): Promise<T> {
		const settled = work();
		admitted.add(settled);
		void settled.finally(() => admitted.delete(settled));
		return settled;
	}

	const gitFailure = (operation: string, answer: Answer<unknown>) =>
		answer.kind === 'missing'
			? GitError.GitMissing({ operation, install: answer.missing.install })
			: GitError.Failed({
					operation,
					cause: answer.kind === 'failed' ? answer.message : 'no reply',
				});

	const scanRunner = createPassRunner<void, Result<FilesObservation, GitError>>(
		{
			async run() {
				const capturedAt = ++clock;
				const answer = await ask<HistoryResults['status']>('status', {
					scope,
				});
				if (answer.kind !== 'reply') {
					const failure = gitFailure('status', answer);
					files =
						files.state === 'observed'
							? { ...files, stale: true, error: failure.error.message }
							: { state: 'unknown', error: failure.error.message };
					emit();
					return failure;
				}
				observe(answer.reply, capturedAt);
				emit();
				return answer.reply.result;
			},
			failed: (cause) => GitError.Failed({ operation: 'status', cause }),
			closed: () => GitError.Closed(),
			onChange: () => emit(),
		},
	);

	function commit({
		message,
	}: {
		message?: string;
	} = {}): Promise<CommitOutcome> {
		if (closing.signal.aborted) return Promise.resolve({ status: 'closed' });
		running.commit++;
		emit();
		return admit(async (): Promise<CommitOutcome> => {
			try {
				const capturedAt = ++clock;
				const answer = await ask<HistoryResults['saveVersion']>(
					'save_version',
					{ scope, message: message ?? null },
				);
				if (answer.kind === 'missing')
					return {
						status: 'blocked',
						reason: gitFailure('commit', answer).error.message,
					};
				// The child may have committed before it stopped.
				if (answer.kind === 'failed')
					return { status: 'unconfirmed', error: answer.message };
				observe(answer.reply, capturedAt);
				return answer.reply.result;
			} finally {
				running.commit--;
				emit();
			}
		});
	}

	/** The credential for the remote a sync reaches, crossing to the child. */
	async function credentialFor(
		connect: string | undefined,
	): Promise<UrlCredential | null> {
		if (credentials === undefined) return null;
		let url = connect ?? state.remote?.url;
		// The page learns its remote from a status reply.
		if (url === undefined) {
			await scanRunner.follow();
			url = state.remote?.url;
		}
		if (url === undefined) return null;
		const credential = await credentials(url, closing.signal);
		return credential === undefined ? null : { url, ...credential };
	}

	/** One sync request: `sync` or `settle_sync`, with what both carry. */
	function syncing(
		run: (
			credential: UrlCredential | null,
		) => Promise<Answer<HistoryResults['sync']>>,
		connect?: string,
	): Promise<Result<SyncOutcome, SyncError>> {
		if (closing.signal.aborted) return Promise.resolve(SyncError.Closed());
		running.merge++;
		emit();
		return admit(async () => {
			try {
				const capturedAt = ++clock;
				let credential: UrlCredential | null;
				try {
					credential = await credentialFor(connect);
				} catch (cause) {
					return SyncError.Fetch({
						error: GitError.Failed({ operation: 'fetch', cause }).error,
					});
				}
				const answer = await run(credential);
				if (answer.kind !== 'reply')
					return SyncError.Failed({ cause: gitFailure('sync', answer).error });
				observe(answer.reply, capturedAt);
				const result = answer.reply.result;
				lastMerge =
					result.error?.name === 'Merge'
						? { result: Err(result.error.error), at: Date.now() }
						: lastMerge;
				return result;
			} finally {
				running.merge--;
				emit();
			}
		});
	}

	const runSync = (options: SyncOptions = {}, connect?: string) =>
		syncing(
			(credential) =>
				ask('sync', {
					scope,
					remote: connect ?? null,
					allowUnrelated: options.allowUnrelatedHistories === true,
					credential,
				}),
			connect,
		);

	function resolveSync(
		attempt: SyncAttempt | Pick<SyncAttempt, 'id'>,
		choices: SyncChoices,
	): Promise<Result<SyncOutcome, SyncError>> {
		// The choices are read once, now: later edits to the caller's object
		// change nothing that is sent.
		const id = (attempt as Partial<SyncAttempt> | null | undefined)?.id;
		let picked: string;
		try {
			picked = encodeHistory(choices) ?? 'null';
		} catch {
			picked = 'null';
		}
		if (typeof id !== 'string')
			return Promise.resolve(SyncError.Stale({ reason: 'replaced' }));
		return syncing((credential) =>
			ask('settle_sync', { scope, attempt: id, choices: picked, credential }),
		);
	}

	const unsupported = (operation: string) =>
		GitError.Failed({ operation, cause: `${operation} ${UNSUPPORTED}` });

	let closed: Promise<void> | undefined;

	const history: History = {
		get snapshot() {
			return snapshot;
		},
		subscribe(listener: (snapshot: GitSnapshot) => void) {
			listener(snapshot);
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		noteEdit() {
			lastEdit = ++clock;
			if (files.state === 'observed' && !files.stale) {
				files = { ...files, stale: true };
				emit();
			}
		},
		status: () => scanRunner.follow(),
		commit,
		async commitAndPush(): Promise<CommitAndPushResult> {
			const outcome = await commit();
			return {
				commit: outcome,
				push: { status: 'skipped', reason: `push ${UNSUPPORTED}` },
			};
		},
		push: async (): Promise<PushOutcome> => ({
			status: 'skipped',
			reason: `push ${UNSUPPORTED}`,
		}),
		fetch: async (): Promise<Result<FetchOutcome, GitError>> =>
			unsupported('fetch'),
		pullFastForward: async (): Promise<
			Result<PullOutcome, PullError | GitError>
		> => unsupported('pull'),
		mergeIncoming: async (): Promise<
			Result<MergeOutcome, MergeError | PullError | GitError>
		> => unsupported('merge'),
		sync: Object.freeze({
			run: (options?: SyncOptions) => runSync(options),
			resolve: resolveSync,
			connect: (url: string, options?: SyncOptions) => runSync(options, url),
		}),
		paths: async (): Promise<Result<PathStatus[], GitError>> =>
			unsupported('status of each path'),
		stage: async (): Promise<Result<undefined, GitError>> => unsupported('add'),
		commitStaged: async (): Promise<Result<StagedCommit, GitError>> =>
			unsupported('commit of staged changes'),
		diff: async (): Promise<Result<string, GitError>> => unsupported('diff'),
		async log(depth: number): Promise<Result<CommitSummary[], GitError>> {
			if (closing.signal.aborted) return GitError.Closed();
			return admit(async () => {
				const capturedAt = ++clock;
				const answer = await ask<HistoryResults['log']>('history', {
					scope,
					depth,
				});
				if (answer.kind !== 'reply') return gitFailure('log', answer);
				observe(answer.reply, capturedAt);
				return answer.reply.result;
			});
		},
		close() {
			closed ??= (async () => {
				closing.abort(new Error('The folder is closed'));
				emit();
				await Promise.all([
					scanRunner.close(),
					Promise.allSettled([...admitted]),
				]);
				emit();
			})();
			return closed;
		},
	};
	emit();
	return history;
}
