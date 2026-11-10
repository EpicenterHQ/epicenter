/**
 * Every way an `epicenter` command can fail to run, as one tagged union
 * (ADR-0842). A run that started never fails this way: whatever happened is
 * in its answer (`report.ts`). Variants carry fields; `message` is for the
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
	/** A Git command `new` ran failed. */
	GitFailed: ({ cause }: { cause: unknown }) => ({
		message: `Git failed: ${extractErrorMessage(cause)}`,
	}),
	/** An app's UI did not build: its `ui/` build failed (ADR-0866). */
	BuildFailed: ({ app, cause }: { app: string; cause: unknown }) => ({
		message: `${app}: the UI did not build: ${extractErrorMessage(cause)}`,
		app,
	}),
	/** `epicenter` itself failed unexpectedly before anything ran: a bug, or a home it cannot read. */
	Internal: ({ cause }: { cause: unknown }) => ({
		message: extractErrorMessage(cause),
	}),
});
export type CliError = InferErrors<typeof CliError>;
