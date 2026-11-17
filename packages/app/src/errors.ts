/**
 * The failures an app's producers and clients share. A name describes why
 * work failed, not which writes persisted. The wire envelope records whether
 * an action ran; a caller reconciles its records to learn what was saved.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';

const NAMESPACE = 'epicenter/action-error' as const;

export type Problem = { line: string; kind: string };

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
	/** An unrecognized throw, with its JSON-safe tagged payload when available. */
	Threw: (body: {
		message: string;
		thrown?: { name: string; message: string } & Record<string, unknown>;
	}) => marked(body),
	/** An operation declined the request. This does not imply the outer action wrote nothing. */
	Refused: (body: { message: string; next?: string }) => marked(body),
	/** A required operation returned no usable answer. The message identifies what failed. */
	Unreachable: (body: { message: string }) => marked(body),
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
