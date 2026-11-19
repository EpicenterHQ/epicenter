/**
 * The failures Epicenter itself answers, and the shape every action error
 * has. Three names belong to the platform and say whether an action ran:
 * `NotStarted` (it never began), `Threw` (it began and threw) and
 * `Unreachable` (the outcome is unknown). The data handles answer `Misfit`,
 * `Exists` and `Missing`. `Refused` is a ready-made name for an action's own
 * refusal. Any other name is the action's own.
 */
import {
	defineErrors,
	type InferError,
	type InferErrors,
} from 'wellcrafted/error';
import type { JsonValue } from './markdown.ts';

/** What every action error is: a name and a message, plus fields of its own. */
export type PublicError = { name: string; message: string };

/** A tagged error an action threw: a name and a message, plus anything else. */
export type Thrown = PublicError & Record<string, unknown>;

/**
 * One reason a file or a change does not fit its fields. `line` names the
 * value; `kind` leaves it out, so many files can share one.
 */
export type Problem = { line: string; kind: string };

/** The names only Epicenter answers. An action that returns one answers `Threw` instead. */
export const RESERVED_NAMES: readonly string[] = ['NotStarted', 'Unreachable'];

export const ActionError = defineErrors({
	/**
	 * A record, or a change to one, does not fit its declared fields. A read
	 * carries the fields that fit as `record`, for repair, unless its front
	 * matter cannot be read; a refused change carries none.
	 */
	Misfit: ({
		path,
		id,
		problems,
		record,
	}: {
		path: string;
		id: string;
		problems: Problem[];
		record?: Record<string, JsonValue>;
	}) => ({
		message: [
			`${path} does not fit its fields:`,
			...problems.map((problem) => `${path}: ${problem.line}`),
		].join('\n'),
		path,
		id,
		problems,
		...(record === undefined ? {} : { record }),
	}),
	/** `create` found a record already there. */
	Exists: ({ path }: { path: string }) => ({
		message: `${path} is already there`,
		path,
	}),
	/** There is no record at this path. */
	Missing: ({ path }: { path: string }) => ({
		message: `There is no ${path}`,
		path,
	}),
	/** The action said no. Epicenter never answers it. */
	Refused: (body: { message: string }) => body,
	/** The action began and threw, with what it threw when that survives JSON. */
	Threw: (body: { message: string; thrown?: Thrown }) => body,
	/**
	 * The outcome is unknown: the connection dropped after the call was sent,
	 * or the answer never came. Only a caller answers it.
	 */
	Unreachable: (body: { message: string }) => body,
	/**
	 * The action never began, so calling again is safe once what `message`
	 * names is fixed. `next` is a command that helps, when there is one.
	 */
	NotStarted: (body: { message: string; next?: string }) => body,
});
export type ActionError = InferErrors<typeof ActionError>;
export type Misfit = InferError<typeof ActionError.Misfit>;
export type Exists = InferError<typeof ActionError.Exists>;
export type Missing = InferError<typeof ActionError.Missing>;
export type NotStarted = InferError<typeof ActionError.NotStarted>;
export type Threw = InferError<typeof ActionError.Threw>;
export type Unreachable = InferError<typeof ActionError.Unreachable>;
