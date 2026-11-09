/**
 * Every way an `epicenter` command can fail to run, as one tagged union
 * (ADR-0842). A run that started never fails this way: whatever happened is
 * in its report (`report.ts`). Variants carry fields; `message` is for the
 * person reading stderr, and `next`, when present, is the command that
 * resolves it.
 */
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';

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
	/** The app's run lock could not be taken, so the action did not start. */
	LockFailed: ({ cause }: { cause: unknown }) => ({
		message: extractErrorMessage(cause),
	}),
	/** A Git command `new` or `add` ran failed. */
	GitFailed: ({ cause }: { cause: unknown }) => ({
		message: `Git failed: ${extractErrorMessage(cause)}`,
	}),
	/** `epicenter` itself failed unexpectedly before anything ran: a bug, or a home it cannot read. */
	Internal: ({ cause }: { cause: unknown }) => ({
		message: extractErrorMessage(cause),
	}),
});
export type CliError = InferErrors<typeof CliError>;
