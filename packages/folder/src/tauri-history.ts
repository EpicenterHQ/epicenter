/**
 * A desktop page's folder history, run by the `epicenter` CLI (ADR-0559).
 *
 * The page runs no Git. Each operation is one fixed command of the
 * Epicenter shell (`status`, `history`, `save_version`, and `sync`),
 * which runs one `epicenter` child over the folder this
 * window was granted and hands back the child's one reply line
 * (`history-wire.ts`). The child runs the same engine a Bun process does
 * (`runHistory`), over the system `git`. Two windows' children take turns
 * under the folder's history lock.
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
 * The history is `FolderGit`: status, the log, Save version, and Sync. The
 * CLI sends the deployment's Git its
 * own token, so the page holds none. A reload or a closed window ends the
 * children it started.
 */
import type { Result } from 'wellcrafted/result';
import type { DirectoryHistory } from './directory-adapter.js';
import { describe } from './errors.js';
import type { FolderHistory } from './folder.js';
import { GitError, SyncError } from './git/errors.js';
import type {
	CommitOutcome,
	FilesObservation,
	GitSnapshot,
	Observation,
	SyncObservation,
} from './git/history.js';
import type { CommitSummary } from './git/objects.js';
import { createPassRunner } from './git/runner.js';
import type { SyncOptions, SyncOutcome } from './git/sync.js';
import type {
	GitMissingReply,
	HistoryReply,
	HistoryResults,
	HistoryState,
} from './history-wire.js';
import { type CliError, type CliExit, commands } from './shell/bindings.gen.js';

/** The reply, or why there is none. */
type Answer<T> =
	| { readonly kind: 'reply'; readonly reply: HistoryReply<T> }
	| { readonly kind: 'missing'; readonly missing: GitMissingReply }
	| { readonly kind: 'failed'; readonly message: string };

function describeCliError(error: CliError): string {
	if (error.name === 'NotGranted')
		return `this window holds no grant for the folder: ${JSON.stringify(error.grant)}`;
	return error.message;
}

/**
 * Run one shell command (`run`, a call of the generated `commands`) and read
 * the child's reply line.
 */
async function ask<T>(
	run: () => Promise<
		{ data: CliExit; error: null } | { data: null; error: CliError }
	>,
): Promise<Answer<T>> {
	let result: Awaited<ReturnType<typeof run>>;
	try {
		result = await run();
	} catch (cause) {
		return { kind: 'failed', message: describe(cause) };
	}
	if (result.error !== null)
		return { kind: 'failed', message: describeCliError(result.error) };
	const output = result.data;
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
		value = JSON.parse(line);
	} catch {
		return { kind: 'failed', message: `epicenter answered ${line}` };
	}
	const { error } = value as { error?: unknown };
	if (error === 'GitMissing')
		return { kind: 'missing', missing: value as GitMissingReply };
	if (typeof error === 'string') return { kind: 'failed', message: error };
	return { kind: 'reply', reply: value as HistoryReply<T> };
}

/**
 * The history of the folder this window was granted under `scope`, over
 * the shell's history commands.
 */
export function cliHistory({
	scope,
}: {
	readonly scope: string;
}): DirectoryHistory<FolderHistory> {
	return async ({ landed }) =>
		() =>
			createCliHistory({ scope, landed });
}

function createCliHistory({
	scope,
	landed,
}: {
	scope: string;
	landed: (paths: readonly string[]) => void;
}): FolderHistory {
	const closing = new AbortController();
	let clock = 0;
	let lastEdit = 0;
	let state: HistoryState = {
		// The CLI records history on `main`; the first reply says so.
		branch: 'main',
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
	const running = { commit: 0, sync: 0 };
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
				push: { active: running.sync > 0 },
				fetch: { active: false },
			},
			lastCommit: state.lastCommit,
			lastPush: state.lastPush,
			lastFetch: undefined,
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
				const answer = await ask<HistoryResults['status']>(() =>
					commands.status(scope),
				);
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
				const answer = await ask<HistoryResults['saveVersion']>(() =>
					commands.saveVersion(scope, message ?? null),
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

	/** One `sync` request. */
	function syncing(
		run: () => Promise<Answer<HistoryResults['sync']>>,
	): Promise<Result<SyncOutcome, SyncError>> {
		if (closing.signal.aborted) return Promise.resolve(SyncError.Closed());
		running.sync++;
		emit();
		return admit(async () => {
			try {
				const capturedAt = ++clock;
				const answer = await run();
				if (answer.kind !== 'reply')
					return SyncError.Failed({ cause: gitFailure('sync', answer).error });
				observe(answer.reply, capturedAt);
				return answer.reply.result;
			} finally {
				running.sync--;
				emit();
			}
		});
	}

	const runSync = (options: SyncOptions = {}, connect?: string) =>
		syncing(() =>
			ask(() =>
				commands.sync(
					scope,
					connect ?? null,
					options.allowUnrelatedHistories === true,
				),
			),
		);

	let closed: Promise<void> | undefined;

	const history: FolderHistory = {
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
		sync: Object.freeze({
			run: (options?: SyncOptions) => runSync(options),
			connect: (url: string, options?: SyncOptions) => runSync(options, url),
		}),
		async log(depth: number): Promise<Result<CommitSummary[], GitError>> {
			if (closing.signal.aborted) return GitError.Closed();
			return admit(async () => {
				const capturedAt = ++clock;
				const answer = await ask<HistoryResults['log']>(() =>
					commands.history(scope, depth),
				);
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
