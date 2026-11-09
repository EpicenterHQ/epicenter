/**
 * One action's run, for the command line and MCP (ADR-0850). The action
 * writes as it runs; whether it returns or throws, `epicenter` commits
 * exactly what it wrote, labelling a failure in the subject. The run's
 * report says what the action did, which writes were refused, what each
 * written path became, and what the push did. Nothing is undone.
 */
import { realpath } from 'node:fs/promises';
import type { Action } from '@epicenter/app';
import { extractErrorMessage } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { commitWrites, createWriteLog } from './commit.ts';
import { folderOnDisk } from './disk.ts';
import { CliError } from './errors.ts';
import { takeFileLock } from './file-lock.ts';
import { git, gitPath, revParse } from './git.ts';
import type { Runnable } from './home.ts';
import { pushToOrigin } from './push.ts';
import type { PathState, RunReport } from './report.ts';
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

/** The run itself, while it holds the app's turn: the action, then the commit of what it wrote. */
async function runInTurn(
	located: Runnable,
	key: string,
	action: Action,
	input: Record<string, unknown>,
	started: (start: { folder: string; head: string | null }) => void,
): Promise<Omit<RunReport, 'push'>> {
	const folder = located.realPath;
	const log = createWriteLog(folder);
	started({ folder, head: await revParse(folder, 'HEAD') });
	let outcome: RunReport['action'];
	try {
		const returned = await action.run(input, {
			folder: folderOnDisk(folder, log),
			secrets: keychain(keychainService(located.name)),
		});
		outcome = { returned: returned ?? null };
	} catch (error) {
		outcome = { threw: threwOf(error) };
	}
	const failure =
		'threw' in outcome ? outcome.threw.message : log.refused[0]?.message;
	const subject = `${located.name} ${key}${failure === undefined ? '' : failureLabel(failure)}`;
	const body = `${JSON.stringify(recorded(action, input))}${'threw' in outcome ? `\n\n${outcome.threw.message}` : ''}`;
	const written = log.written();
	let commit: RunReport['commit'];
	let states = new Map<string, PathState>();
	try {
		({ commit, states } = await commitWrites(folder, {
			written,
			subject,
			body,
		}));
	} catch (error) {
		commit = { failed: extractErrorMessage(error) };
	}
	return {
		action: outcome,
		refused: [...log.refused],
		commit,
		paths: written.map(([path]) => ({
			path,
			state: states.get(path) ?? 'not-committed',
		})),
	};
}

/** Check the repository before an action starts, then hold its turn through the commit. */
export async function runAction(
	located: Runnable,
	key: string,
	input: Record<string, unknown>,
	/** Called once the run holds the app's turn, with the HEAD it starts from. */
	started: (start: { folder: string; head: string | null }) => void,
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
	let release: () => void;
	try {
		release = await takeFileLock(await gitPath(folder, 'epicenter.lock'));
	} catch (error) {
		return CliError.LockFailed({ cause: error });
	}
	let report: Omit<RunReport, 'push'>;
	try {
		report = await runInTurn(located, key, action, input, started);
	} finally {
		release();
	}
	// After the lock, so a slow push never holds up the app's next run.
	const pushed = report.commit && 'sha' in report.commit;
	return Ok({ ...report, push: pushed ? await pushToOrigin(folder) : null });
}
