/**
 * The failures an app's producers and clients share. Three names belong to
 * the platform's handling of a call and say whether the action ran
 * (ADR-0953): `NotStarted` (it never began), `Threw` (it began and threw) and
 * `Unreachable` (the outcome is unknown). Any other name is the action's own
 * answer, so the action ran. A name does not say which writes persisted; a
 * caller rereads its records to learn what was saved.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';

const NAMESPACE = 'epicenter/action-error' as const;

export type Problem = { line: string; kind: string };

/**
 * Why a call never began: its words or input do not fit, its app cannot
 * load, Epicenter failed before it ran, or no serve for this home answers.
 */
export type NotStartedCause =
	| 'usage'
	| 'app-problems'
	| 'internal'
	| 'unavailable';

/** The names only Epicenter answers. An action that returns one answers `Threw` instead. */
export const RESERVED_NAMES: readonly string[] = ['NotStarted', 'Unreachable'];

const WHY = {
	quote:
		"'s body does not have that text; it may have changed since it was read, so get it again",
	twice:
		"'s body has that text more than once; quote more around it, or the whole body",
	there: ' is already there',
};

/** The enumerable marker survives the runner's JSON serialization. It is not proof of origin. */
function marked<T extends { message: string }>(body: T) {
	return { ...body, namespace: NAMESPACE };
}

export const ActionError = defineErrors({
	/**
	 * A file does not fit its declared fields. `id` is the file's name in a
	 * folder key; a one-file key has none. An unreadable file omits the
	 * partial record.
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
		record?: Record<string, unknown>;
	}) =>
		marked({
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
	Changed: ({ path, why }: { path: string; why: keyof typeof WHY }) =>
		marked({ message: `${path}${WHY[why]}`, path, why }),
	/** There is no file at this path. It may be a dependency of the requested action. */
	Missing: ({ path }: { path: string }) =>
		marked({ message: `There is no ${path}`, path }),
	/** The action began and threw, with its JSON-safe tagged payload when available. */
	Threw: (body: {
		message: string;
		thrown?: { name: string; message: string } & Record<string, unknown>;
	}) => marked(body),
	/** An operation declined the request. This does not imply the outer action wrote nothing. */
	Refused: (body: { message: string; next?: string }) => marked(body),
	/**
	 * The call's outcome is unknown: the connection dropped after it was
	 * sent, a line was not a valid frame, or the answer never came. Only a
	 * caller answers it; serve turns an action's own into `Threw`.
	 */
	Unreachable: (body: { message: string }) => marked(body),
	/**
	 * The action never began, so it is safe to call again once `cause` is
	 * fixed. `next` is the command that helps; `problems` are why the app
	 * cannot load. Only serve and the CLI answer it; serve turns an action's
	 * own into `Threw`.
	 */
	NotStarted: ({
		message,
		cause,
		next,
		problems,
	}: {
		message: string;
		cause: NotStartedCause;
		next?: string;
		problems?: string[];
	}) =>
		marked({
			message,
			cause,
			...(next === undefined ? {} : { next }),
			...(problems === undefined ? {} : { problems }),
		}),
});
export type ActionError = InferErrors<typeof ActionError>;

/**
 * Whether a value received through JSON is a platform error: the platform's
 * marker, a known name, and a text message. The page and serve are one
 * version, so the other fields are not checked.
 */
export function isActionError(value: unknown): value is ActionError {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return false;
	const body = value as Record<string, unknown>;
	return (
		body.namespace === NAMESPACE &&
		typeof body.name === 'string' &&
		Object.hasOwn(ActionError, body.name) &&
		typeof body.message === 'string'
	);
}
