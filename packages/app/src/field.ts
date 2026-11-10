/**
 * The fields a collection's files and an action's input are made of. Each is
 * a TypeBox schema, which is JSON Schema, so raw TypeBox sits beside them. The
 * CLI reads a field as a flag named for its key, and as a positional when the
 * action lists it; MCP shows it as a property of the tool's input.
 *
 * A field is required unless it says `optional`. A switch (`boolean`) and a
 * list (`tags`) are never required: an absent switch is `false`, an absent
 * list is empty. A collection's field that says `readOnly` is written only by
 * the app's own actions: the exposed `add` and `set` leave it out.
 */
import {
	type TArray,
	type TBoolean,
	type TLiteral,
	type TOptional,
	type TSchema,
	type TString,
	type TUnion,
	Type,
} from 'typebox';

type Options = {
	description?: string;
	/** JSON Schema's `readOnly`: in a collection, only the app's own actions write it. */
	readOnly?: boolean;
};

type MaybeOptional = Options & { optional?: boolean };

/** `T` marked as JSON Schema's `readOnly` when the options say so, so types can leave it out. */
type Marked<T extends TSchema, O> = O extends { readOnly: true }
	? T & { readOnly: true }
	: T;

type Optionally<T extends TSchema, O> = Marked<
	O extends { optional: true } ? TOptional<T> : T,
	O
>;

/** A switch: `false` unless its flag is given. */
export type TSwitch = TOptional<TBoolean> & { default: false };

/** A list of text: every time its flag is given, or every word left when it is the last positional; empty unless given. */
export type TTags = TOptional<TArray<TString>> & { default: string[] };

function maybeOptional<T extends TSchema, O extends MaybeOptional>(
	schema: T,
	options: O | undefined,
): Optionally<T, O> {
	return (options?.optional ? Type.Optional(schema) : schema) as Optionally<
		T,
		O
	>;
}

/** The schema options a field carries: its description, and whether it is read-only. */
function schemaOptions(options: Options | undefined) {
	return {
		...(options?.description === undefined
			? {}
			: { description: options.description }),
		...(options?.readOnly ? { readOnly: true } : {}),
	};
}

export const field = {
	/**
	 * Text. `pattern` is a regular expression the whole value must match; give
	 * a `description` that reads after "must be", since that is how a refusal
	 * names it: `{ pattern: '^\\S.*$', description: 'one line, not blank' }`.
	 */
	text: <const O extends MaybeOptional & { pattern?: string }>(options?: O) =>
		maybeOptional(
			Type.String({
				...schemaOptions(options),
				...(options?.pattern === undefined ? {} : { pattern: options.pattern }),
			}),
			options,
		),

	number: <const O extends MaybeOptional & { min?: number }>(options?: O) =>
		maybeOptional(
			Type.Number({
				...schemaOptions(options),
				...(options?.min === undefined ? {} : { minimum: options.min }),
			}),
			options,
		),

	/** A whole number. */
	integer: <const O extends MaybeOptional & { min?: number }>(options?: O) =>
		maybeOptional(
			Type.Integer({
				...schemaOptions(options),
				...(options?.min === undefined ? {} : { minimum: options.min }),
			}),
			options,
		),

	/** A moment, written RFC 3339 with an offset (`2026-11-10T22:41:05+08:00`): JSON Schema's `format: 'date-time'`. */
	datetime: <const O extends MaybeOptional>(options?: O) =>
		maybeOptional(
			Type.String({ ...schemaOptions(options), format: 'date-time' }),
			options,
		),

	/** A day, written `2026-11-08`: JSON Schema's `format: 'date'`, which TypeBox checks, so `2026-13-45` is refused. */
	date: <const O extends MaybeOptional>(options?: O) =>
		maybeOptional(
			Type.String({ ...schemaOptions(options), format: 'date' }),
			options,
		),

	/** One of `values`, as `field.select(['archive', 'trash'])`. */
	select: <
		const V extends readonly [string, ...string[]],
		const O extends MaybeOptional,
	>(
		values: V,
		options?: O,
	) =>
		maybeOptional(
			Type.Union(
				values.map((value) => Type.Literal(value)),
				schemaOptions(options),
			) as unknown as TUnion<{ -readonly [K in keyof V]: TLiteral<V[K]> }>,
			options,
		),

	boolean: <const O extends Options>(options?: O) =>
		Type.Optional(
			Type.Boolean({ ...schemaOptions(options), default: false }),
		) as Marked<TSwitch, O>,

	tags: <const O extends Options>(options?: O) =>
		Type.Optional(
			Type.Array(Type.String(), { ...schemaOptions(options), default: [] }),
		) as Marked<TTags, O>,
};
