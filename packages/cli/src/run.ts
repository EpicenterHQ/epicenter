/**
 * One action's run, for the command line and MCP (ADR-0850). The action
 * writes as it runs; whether it returns or throws, `epicenter` commits
 * exactly what it wrote, labelling a failure in the subject. The run's
 * report says what the action did, which writes were refused, what each
 * written path became, and what the push did. Nothing is undone.
 */
import { realpath } from 'node:fs/promises';
import { format } from 'node:util';
import type { Action } from '@epicenter/app';
import { extractErrorMessage } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { commitWrites, createWriteLog } from './commit.ts';
import { folderOnDisk } from './disk.ts';
import { CliError } from './errors.ts';
import { holdingFileLock, NothingChanged } from './file-lock.ts';
import { git, gitPath, revParse } from './git.ts';
import type { Runnable } from './home.ts';
import { pushToOrigin } from './push.ts';
import type { RunReport } from './report.ts';
import { keychain, keychainService } from './secrets.ts';

/** The longest a failure's first line may be in a commit subject before it is cut. */
const SUBJECT_FAILURE = 60;

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
 * What the action threw, as the report carries it. A thrown tagged error (a
 * frozen `{ name, message, ...fields }`, as wellcrafted's `defineErrors`
 * makes) is kept whole so its name and fields reach the caller.
 */
function threwOf(cause: unknown): {
	message: string;
	thrown?: Record<string, unknown>;
} {
	const message = extractErrorMessage(cause);
	if (typeof cause !== 'object' || cause === null || cause instanceof Error)
		return { message };
	const { name } = cause as { name?: unknown };
	if (
		typeof name !== 'string' ||
		typeof (cause as { message?: unknown }).message !== 'string'
	)
		return { message };
	return { message, thrown: JSON.parse(JSON.stringify(cause)) };
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
): Promise<Result<RunReport, CliError>> {
	const folder = located.realPath;
	const top = await git(folder, ['rev-parse', '--show-toplevel']);
	if (
		top.code !== 0 ||
		(await realpath(top.stdout.toString().trim())) !== folder
	)
		return CliError.NotRepository({ folder });
	if ((await revParse(folder, 'MERGE_HEAD')) !== null)
		return CliError.MidMerge({ folder });
	const action = located.actions[key];
	if (!action)
		return CliError.Usage({
			message: `Unknown action ${located.name} ${key}`,
			next: `epicenter ${located.name}`,
		});
	try {
		return Ok(
			await holdingFileLock(
				await gitPath(folder, 'epicenter.lock'),
				{ waitMs: 86_400_000, held: `${located.name} is busy` },
				async (): Promise<RunReport> => {
					const log = createWriteLog(folder);
					const outcome = await withStdoutKept(
						async (): Promise<RunReport['action']> => {
							try {
								const returned = await action.run(input, {
									folder: folderOnDisk(folder, log),
									secrets: keychain(keychainService(located.name)),
								});
								return { returned: returned ?? null };
							} catch (error) {
								return { threw: threwOf(error) };
							}
						},
					);
					const failure =
						'threw' in outcome
							? outcome.threw.message
							: log.refused[0]?.message;
					const subject = `${located.name} ${key}${failure === undefined ? '' : failureLabel(failure)}`;
					const body = `${JSON.stringify(recorded(action, input))}${'threw' in outcome ? `\n\n${outcome.threw.message}` : ''}`;
					const written = log.written();
					const refused = [...log.refused];
					let made: Awaited<ReturnType<typeof commitWrites>>;
					try {
						made = await commitWrites(folder, { written, subject, body });
					} catch (error) {
						return {
							action: outcome,
							refused,
							commit: { failed: extractErrorMessage(error) },
							paths: written.map(([path]) => ({
								path,
								state: 'not-committed',
							})),
							push: null,
						};
					}
					return {
						action: outcome,
						refused,
						commit: made.commit,
						paths: written.map(([path]) => ({
							path,
							state: made.states.get(path) ?? 'not-committed',
						})),
						push: made.commit ? await pushToOrigin(folder) : null,
					};
				},
			),
		);
	} catch (error) {
		// Only a lock never taken means the action did not run; anything else is a bug and propagates.
		if (error instanceof NothingChanged)
			return CliError.LockFailed({ cause: error });
		throw error;
	}
}
