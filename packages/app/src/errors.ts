/**
 * The failures an app's producers and clients share. A name describes why
 * work failed, not which writes persisted. The wire envelope records whether
 * an action ran; a caller reconciles its records to learn what was saved.
 */
import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';
import { defineErrors, type InferErrors } from 'wellcrafted/error';

const NAMESPACE = 'epicenter/action-error' as const;

const runIdentity = Type.Object({
	app: Type.String(),
	action: Type.String(),
	id: Type.String(),
});

const fields = {
	Changed: Type.Object({
		path: Type.String(),
		why: Type.Union([
			Type.Literal('quote'),
			Type.Literal('twice'),
			Type.Literal('empty'),
			Type.Literal('was'),
			Type.Literal('kept'),
		]),
	}),
	Missing: Type.Object({ path: Type.String() }),
	Threw: Type.Object({
		message: Type.String(),
		thrown: Type.Optional(
			Type.Intersect([
				Type.Object({ name: Type.String(), message: Type.String() }),
				Type.Record(Type.String(), Type.Unknown()),
			]),
		),
	}),
	Refused: Type.Object({
		message: Type.String(),
		next: Type.Optional(Type.String()),
	}),
	Unreachable: Type.Object({
		message: Type.String(),
		run: Type.Optional(runIdentity),
	}),
	Stopped: Type.Object({
		message: Type.String(),
		run: Type.Optional(runIdentity),
	}),
};

const WHY = {
	quote:
		"'s body does not have that text; it may have changed since it was read, so get it again",
	twice:
		"'s body has that text more than once; quote more around it, or the whole body",
	empty: "'s body is no longer empty; get it again",
	was: ' no longer holds a value named in was; it changed since it was read, so get it again',
	kept: ' kept changing while it was updated',
} satisfies Record<Static<typeof fields.Changed>['why'], string>;

/** The enumerable marker survives the runner's JSON serialization. It is not proof of origin. */
function marked<T extends { message: string }>(body: T) {
	return { ...body, namespace: NAMESPACE };
}

export const ActionError = defineErrors({
	/** The quoted passage, empty body, field values, or file a write depended on changed, or a quote is not one place. */
	Changed: ({ path, why }: Static<typeof fields.Changed>) =>
		marked({ message: `${path}${WHY[why]}`, path, why }),
	/** There is no file at this path. It may be a dependency of the requested action. */
	Missing: ({ path }: Static<typeof fields.Missing>) =>
		marked({ message: `There is no ${path}`, path }),
	/** An unrecognized throw, with its JSON-safe tagged payload when available. */
	Threw: ({ message, thrown }: Static<typeof fields.Threw>) =>
		marked({ message, thrown }),
	/** An operation declined the request. This does not imply the outer action wrote nothing. */
	Refused: ({ message, next }: Static<typeof fields.Refused>) =>
		marked({ message, next }),
	/** A required operation returned no usable answer. The message identifies what failed. */
	Unreachable: ({ message, run }: Static<typeof fields.Unreachable>) =>
		marked({ message, ...(run ? { run } : {}) }),
	/** Work was deliberately stopped. This does not confirm completed cleanup or rollback. */
	Stopped: ({ message, run }: Static<typeof fields.Stopped>) =>
		marked({ message, ...(run ? { run } : {}) }),
});
export type ActionError = InferErrors<typeof ActionError>;

/** Validate a shared error received through JSON, preserving its message and extra fields. */
export function isActionError(value: unknown): value is ActionError {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return false;
	const body = value as Record<string, unknown>;
	if (
		body.namespace !== NAMESPACE ||
		typeof body.name !== 'string' ||
		typeof body.message !== 'string' ||
		!Object.hasOwn(ActionError, body.name)
	)
		return false;
	return Value.Check(fields[body.name as ActionError['name']], body);
}
