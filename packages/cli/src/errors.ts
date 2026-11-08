/**
 * Every way `epicenter` can fail, as one tagged union (ADR-0842, ADR-0850).
 * Variants carry fields; `message` is for the person reading stderr, and
 * `next`, when present, is the command that resolves it. One boundary
 * (`output.ts`) turns a variant into an exit code, stderr lines, the `--json`
 * object, and the MCP result.
 */
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';

/** The commit `epicenter` made for a run: its full sha, subject, and the paths it holds. */
export type Commit = { sha: string; subject: string; paths: string[] };

/** What a run left behind, beside its answer or its failure. */
export type Outcome = { commit: Commit | null; uncommitted: string[] };

/**
 * A thrown value that is itself a tagged error (a frozen `{ name, message,
 * ...fields }`, as wellcrafted's `defineErrors` makes), kept whole so its name
 * and fields reach the caller.
 */
function taggedOf(cause: unknown) {
	if (typeof cause !== 'object' || cause === null || cause instanceof Error)
		return undefined;
	const { name, message } = cause as { name?: unknown; message?: unknown };
	if (typeof name !== 'string' || typeof message !== 'string') return undefined;
	return JSON.parse(JSON.stringify(cause)) as Record<string, unknown>;
}

export const CliError = defineErrors({
	/** The words or flags do not name something to run, or the input does not fit. */
	Usage: ({ message, next }: { message: string; next?: string }) => ({
		message,
		...(next === undefined ? {} : { next }),
	}),
	/** The app cannot run until these are fixed. */
	AppProblems: ({ app, problems }: { app: string; problems: string[] }) => ({
		message: `${app}: ${problems.join('; ')}`,
		app,
		problems,
	}),
	/** An action runs only in a folder that is the top of its own repository. */
	NotRepository: ({ folder }: { folder: string }) => ({
		message: `${folder} must be the top level of a Git repository`,
		folder,
		next: `git -C ${folder} init`,
	}),
	/** An action's commit cannot be made in the middle of a merge, so it does not start. */
	MidMerge: ({ folder }: { folder: string }) => ({
		message: `${folder} is in the middle of a merge; resolve the conflicts and commit first`,
		folder,
		next: `git -C ${folder} status`,
	}),
	/** The action tried to write a path someone else had changed; nothing was written to it. */
	PathUncommitted: ({
		folder,
		path,
		during,
		commit,
		uncommitted,
	}: Outcome & { folder: string; path: string; during: boolean }) => ({
		message: during
			? `${path} changed during the run, so the action did not overwrite it`
			: `${path} has changes you have not committed, so the action did not write it`,
		folder,
		path,
		next: `git -C ${folder} status -- ${path}`,
		commit,
		uncommitted,
	}),
	/** The action threw; what it wrote before throwing is committed, labelled with the failure. */
	ActionThrew: ({
		cause,
		commit,
		uncommitted,
	}: Outcome & { cause: unknown }) => {
		const thrown = taggedOf(cause);
		return {
			message: extractErrorMessage(cause),
			...(thrown ? { thrown } : {}),
			commit,
			uncommitted,
		};
	},
	/** A Git command `epicenter` ran for itself failed. */
	GitFailed: ({ cause }: { cause: unknown }) => ({
		message: `Git failed: ${extractErrorMessage(cause)}`,
	}),
	/** Git refused the commit; the action's writes are on disk, uncommitted. */
	CommitFailed: ({
		cause,
		uncommitted,
	}: {
		cause: unknown;
		uncommitted: string[];
	}) => ({
		message: `Could not commit the action's writes: ${extractErrorMessage(cause)}`,
		commit: null,
		uncommitted,
	}),
});
export type CliError = InferErrors<typeof CliError>;

/** 2: it did not run. 3: it ran, and failed or threw. */
export function exitCodeOf(error: CliError): 2 | 3 {
	switch (error.name) {
		case 'Usage':
		case 'AppProblems':
		case 'NotRepository':
		case 'MidMerge':
			return 2;
		case 'PathUncommitted':
		case 'ActionThrew':
		case 'CommitFailed':
		case 'GitFailed':
			return 3;
		default:
			return error satisfies never;
	}
}
