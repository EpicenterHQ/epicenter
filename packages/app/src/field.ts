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
import { Value } from 'typebox/value';

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

type Bounds = { min?: number; max?: number };

/** JSON Schema's `minimum` and `maximum` for the bounds given. */
function bounds(options: Bounds | undefined) {
	return {
		...(options?.min === undefined ? {} : { minimum: options.min }),
		...(options?.max === undefined ? {} : { maximum: options.max }),
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

	/** A number, at least `min` and at most `max` when they are given. */
	number: <const O extends MaybeOptional & Bounds>(options?: O) =>
		maybeOptional(
			Type.Number({ ...schemaOptions(options), ...bounds(options) }),
			options,
		),

	/** A whole number, at least `min` and at most `max` when they are given. */
	integer: <const O extends MaybeOptional & Bounds>(options?: O) =>
		maybeOptional(
			Type.Integer({ ...schemaOptions(options), ...bounds(options) }),
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

type Described = {
	type?: string;
	format?: string;
	pattern?: string;
	description?: string;
	minimum?: number;
	maximum?: number;
	items?: Described;
	anyOf?: Described[];
	const?: unknown;
	enum?: unknown[];
};

const FORMATS: Record<string, string> = {
	date: 'a day like 2026-11-12',
	'date-time': 'a date and time like 2026-11-12T09:30:00Z',
	uri: 'a URL like https://example.com',
	email: 'an email address',
};

const TYPES: Record<string, string> = {
	string: 'text',
	number: 'a number',
	integer: 'a whole number',
	boolean: 'true or false',
	array: 'a list',
	object: 'an object',
};

/** The checks `whatFits` says in words; another, such as `maxLength`, keeps TypeBox's message. */
const SAID = new Set([
	'type',
	'format',
	'const',
	'anyOf',
	'enum',
	'pattern',
	'minimum',
	'maximum',
]);

/** The schema a field takes besides `null`: `X | null`, as `set` takes a field, is `X`. */
function withoutNull(field: TSchema): TSchema {
	const { anyOf } = field as Described;
	const nonNull = anyOf?.filter((choice) => choice.type !== 'null');
	return anyOf?.length === 2 && nonNull?.length === 1 && nonNull[0]
		? (nonNull[0] as TSchema)
		: field;
}

/** What `schema` takes, as the end of "<value> is not …". */
function wanted(schema: Described): string | undefined {
	const choices =
		schema.enum ??
		(schema.anyOf?.every((choice) => 'const' in choice)
			? schema.anyOf.map((choice) => choice.const)
			: undefined);
	if (choices) return `one of ${choices.map(String).join(', ')}`;
	// A pattern is a regular expression; the field's description says it in words.
	if (schema.pattern !== undefined) return schema.description;
	if (schema.format !== undefined) return FORMATS[schema.format];
	if (schema.type === 'array' && schema.items?.type === 'string')
		return 'a list of text';
	const kind = schema.type === undefined ? undefined : TYPES[schema.type];
	if (!kind) return kind;
	const { minimum: min, maximum: max } = schema;
	if (min !== undefined && max !== undefined)
		return `${kind} from ${min} to ${max}`;
	if (min !== undefined) return `${kind} of at least ${min}`;
	if (max !== undefined) return `${kind} of at most ${max}`;
	return kind;
}

/**
 * What a field takes, in words such as `a day like 2026-11-12` or `a whole
 * number from 1 to 5`, when `value` does not fit it for a reason those words
 * say; `undefined` when it fits, or when they would not say why (a text too
 * long). The CLI says it of a flag and a collection of a file's front matter,
 * so both say it alike.
 */
export function whatFits(field: TSchema, value: unknown): string | undefined {
	if (Value.Check(field, value)) return undefined;
	const schema = withoutNull(field);
	const [error] = Value.Errors(schema, value);
	if (!error || !SAID.has(error.keyword)) return undefined;
	return wanted(schema as Described);
}
