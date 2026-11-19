/**
 * The failures an app's producers and clients share. Three names belong to
 * the platform's handling of a call and say whether the action ran
 * (ADR-0953): `NotStarted` (it never began), `Threw` (it began and threw) and
 * `Unreachable` (the outcome is unknown). Any other name is the action's own
 * answer, so the action ran. A name does not say which writes persisted; a
 * caller rereads its records to learn what was saved.
 */
import {
	defineErrors,
	type InferError,
	type InferErrors,
} from 'wellcrafted/error';
import type { JsonValue } from './front-matter.ts';

export type Problem = { line: string; kind: string };

/** The names only Epicenter answers. An action that returns one answers `Threw` instead. */
export const RESERVED_NAMES: readonly string[] = ['NotStarted', 'Unreachable'];

const CHANGED = {
	quote:
		"'s body does not have that text; it may have changed since it was read, so get it again",
	twice:
		"'s body has that text more than once; quote more around it, or the whole body",
	there: ' is already there',
};

export const ActionError = defineErrors({
	/**
	 * A file, or a change to one, does not fit its declared fields. `id` is the
	 * file's name; an id that cannot name a file has none, and its `path` is
	 * the key's folder. A read
	 * carries the partial `record` for repair, unless the file is unreadable; a
	 * refused change carries none.
	 */
	Misfit: ({
		path,
		id,
		problems,
		record,
	}: {
		path: string;
		id?: string;
		problems: Problem[];
		record?: Record<string, JsonValue>;
	}) => ({
		message: [
			`${path} does not fit its fields:`,
			...problems.map((problem) => `${path}: ${problem.line}`),
		].join('\n'),
		path,
		...(id === undefined ? {} : { id }),
		problems,
		...(record === undefined ? {} : { record }),
	}),
	/** The quoted passage changed or is not in one place, or a new file is already there. */
	Changed: ({
		path,
		cause,
	}: {
		path: string;
		cause: keyof typeof CHANGED;
	}) => ({
		message: `${path}${CHANGED[cause]}`,
		path,
		cause,
	}),
	/** There is no file at this path. It may be a dependency of the requested action. */
	Missing: ({ path }: { path: string }) => ({
		message: `There is no ${path}`,
		path,
	}),
	/** The action began and threw, with its JSON-safe tagged payload when available. */
	Threw: (body: {
		message: string;
		thrown?: { name: string; message: string } & Record<string, unknown>;
	}) => body,
	/**
	 * The app said no: a ready-made name for an action's own refusal. Epicenter
	 * never answers it; a write that does not fit the declared fields is `Misfit`.
	 * It does not imply the action wrote nothing.
	 */
	Refused: (body: { message: string; next?: string }) => body,
	/**
	 * The call's outcome is unknown: the connection dropped after it was
	 * sent, a line was not a valid frame, or the answer never came. Only a
	 * caller answers it; serve turns an action's own into `Threw`.
	 */
	Unreachable: (body: { message: string }) => body,
	/**
	 * The action never began, so it is safe to call again once what `message`
	 * names is fixed. `next` is the command that helps, when there is one.
	 * Only serve and the CLI answer it; serve turns an action's own into
	 * `Threw`.
	 */
	NotStarted: (body: { message: string; next?: string }) => body,
});
export type ActionError = InferErrors<typeof ActionError>;
/** The action never began. */
export type NotStarted = InferError<typeof ActionError.NotStarted>;
/** The action began and threw. */
export type Threw = InferError<typeof ActionError.Threw>;
/** The call's outcome is unknown. */
export type Unreachable = InferError<typeof ActionError.Unreachable>;
/** A file or change that does not fit; a read's carries the fields that do as `record`. */
export type Misfit = InferError<typeof ActionError.Misfit>;
/** The file is not as the write needed it. */
export type Changed = InferError<typeof ActionError.Changed>;
/** There is no file for the id. */
export type Missing = InferError<typeof ActionError.Missing>;
