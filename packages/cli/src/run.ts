/**
 * One action's run, for the command line and MCP (ADR-0850). The action
 * writes as it runs; whether it returns or throws, `epicenter` commits
 * exactly what it wrote, labelling a failure in the subject, and names any
 * path someone changed after the action wrote it. Nothing is undone.
 */
import { realpath } from 'node:fs/promises';
import { format } from 'node:util';
import type { Action } from '@epicenter/app';
import { Ok, type Result } from 'wellcrafted/result';
import {
	changedSince,
	commitWrites,
	createWriteLog,
	gitPath,
	LfsUnavailable,
	PathRefused,
} from './commit.ts';
import { folderOnDisk } from './disk.ts';
import { CliError, type Outcome } from './errors.ts';
import { holdingFileLock, NothingChanged } from './file-lock.ts';
import { git, revParse } from './git.ts';
import type { Runnable } from './home.ts';
import { type Pushed, pushToOrigin } from './push.ts';
import { keychain, keychainService } from './secrets.ts';

/** What a run that returned produced: its answer, and what it left behind. */
export type Ran = Outcome & { result: unknown };

/** A run's outcome, and what the push after its commit did, when there was one. */
export type RunReport = { outcome: Result<Ran, CliError>; pushed?: Pushed };

/** The longest a failure's first line may be in a commit subject before it is cut. */
const SUBJECT_FAILURE = 60;

function messageOf(cause: unknown) {
	if (cause instanceof Error) return cause.message;
	const message = (cause as { message?: unknown } | null)?.message;
	return typeof message === 'string' ? message : String(cause);
}

/** `(failed: <first line>)`, the first line cut at a word to about 60 characters. */
function failureLabel(message: string) {
	const first = message.split('\n')[0]?.trim() || 'an error';
	if (first.length <= SUBJECT_FAILURE) return ` (failed: ${first})`;
	const cut = first.slice(0, SUBJECT_FAILURE - 1);
	const word = cut.lastIndexOf(' ');
	return ` (failed: ${(word > SUBJECT_FAILURE / 2 ? cut.slice(0, word) : cut).trimEnd()}…)`;
}

/** The input as the commit body records it: every field except those marked `writeOnly`. */
function recorded(action: Action, input: Record<string, unknown>) {
	return Object.fromEntries(
		Object.entries(input).filter(
			([key]) =>
				(action.input[key] as { writeOnly?: unknown } | undefined)
					?.writeOnly !== true,
		),
	);
}

/**
 * While the action runs, stdout is epicenter's: `console.log` and
 * `console.info` go to stderr, so `--json` and `serve --stdio` stay one
 * answer each.
 */
async function withStdoutKept<T>(work: () => Promise<T>) {
	const { log, info } = console;
	const toStderr = (...args: unknown[]) => {
		process.stderr.write(`${format(...args)}\n`);
	};
	console.log = toStderr;
	console.info = toStderr;
	try {
		return await work();
	} finally {
		console.log = log;
		console.info = info;
	}
}

/** Check the repository before an action starts, then hold its turn through the commit. */
export async function runAction(
	located: Runnable,
	key: string,
	input: Record<string, unknown>,
): Promise<RunReport> {
	const folder = located.realPath;
	const top = await git(folder, 'rev-parse', '--show-toplevel');
	if (
		top.code !== 0 ||
		(await realpath(top.stdout.toString().trim())) !== folder
	)
		return { outcome: CliError.NotRepository({ folder }) };
	if ((await revParse(folder, 'MERGE_HEAD')) !== null)
		return { outcome: CliError.MidMerge({ folder }) };
	const action = located.actions[key];
	if (!action)
		return {
			outcome: CliError.Usage({
				message: `Unknown action ${located.name} ${key}`,
				next: `epicenter ${located.name}`,
			}),
		};
	try {
		return await holdingFileLock(
			await gitPath(folder, 'epicenter.lock'),
			{ waitMs: 86_400_000, held: `${located.name} is busy` },
			async () => {
				const startHead = await revParse(folder, 'HEAD');
				const log = createWriteLog(folder);
				let result: unknown;
				let threw = false;
				let cause: unknown;
				await withStdoutKept(async () => {
					try {
						result = await action.run(input, {
							folder: folderOnDisk(folder, log),
							secrets: keychain(keychainService(located.name)),
						});
					} catch (error) {
						threw = true;
						cause = error;
					}
				});
				const subject = `${located.name} ${key}${threw ? failureLabel(messageOf(cause)) : ''}`;
				const body = `${JSON.stringify(recorded(action, input))}${threw ? `\n\n${messageOf(cause)}` : ''}`;
				let made: Awaited<ReturnType<typeof commitWrites>>;
				try {
					made = await commitWrites(folder, {
						startHead,
						writes: log.writes,
						subject,
						body,
					});
				} catch (error) {
					return {
						outcome: CliError.CommitFailed({
							cause: error,
							uncommitted: [...log.writes.keys()].sort(),
						}),
					};
				}
				const committed = new Map(
					[...log.writes].filter(([path]) => made.commit?.paths.includes(path)),
				);
				const uncommitted = [
					...new Set([
						...made.contested,
						...(await changedSince(folder, committed)),
					]),
				].sort();
				const left = { commit: made.commit, uncommitted };
				const pushed = made.commit ? await pushToOrigin(folder) : undefined;
				const report = (outcome: Result<Ran, CliError>): RunReport =>
					pushed ? { outcome, pushed } : { outcome };
				if (cause instanceof PathRefused)
					return report(
						CliError.PathUncommitted({
							folder,
							path: cause.path,
							during: cause.during,
							...left,
						}),
					);
				if (cause instanceof LfsUnavailable)
					return report(
						CliError.GitLfsMissing({
							folder,
							path: cause.path,
							installed: cause.installed,
							...left,
						}),
					);
				if (threw) return report(CliError.ActionThrew({ cause, ...left }));
				return report(Ok({ result, ...left }));
			},
		);
	} catch (error) {
		// Only a lock never taken means the action did not run; anything else is a bug and propagates.
		if (error instanceof NothingChanged)
			return { outcome: CliError.Usage({ message: messageOf(error) }) };
		throw error;
	}
}
