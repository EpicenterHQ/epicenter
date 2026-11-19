/**
 * The fields a data file and an action's input are made of. Each is
 * a TypeBox schema, which is JSON Schema, so raw TypeBox sits beside them.
 * Every caller gives an action's input as one JSON object whose keys are its
 * fields; MCP shows each as a property of the tool's input.
 *
 * Every field is required unless it says `optional`, and an absent optional
 * field stays absent: nothing is filled in. The code that reads a value
 * writes its default, as `({ done = false, tags = [] })`. No helper takes a
 * JSON Schema `default`, and nothing applies one given in raw TypeBox.
 */
import {
	type TLiteral,
	type TOptional,
	type TSchema,
	type TUnion,
	Type,
} from 'typebox';
import { Value } from 'typebox/value';

/** Declared fields, each a TypeBox schema. */
export type Fields = Record<string, TSchema>;

/** `T` written out as one object type, without `readonly`, so an editor shows its keys. */
export type Flat<T> = { -readonly [K in keyof T]: T[K] } & {};

/** What every field helper takes: a description, and whether it may be absent. */
type Options = {
	description?: string;
	optional?: boolean;
};

/**
 * Throw when `options` names one `helper` does not declare, so it is never
 * dropped without a word. A `default` gets its own sentence: no field has one.
 */
function only(
	helper: string,
	options: object | undefined,
	declared: readonly string[],
) {
	if (
		options !== undefined &&
		(typeof options !== 'object' || options === null || Array.isArray(options))
	)
		throw new Error(
			`field.${helper} takes its options as an object, such as { optional: true }, not ${JSON.stringify(options)}`,
		);
	for (const key of Object.keys(options ?? {})) {
		if (declared.includes(key)) continue;
		throw new Error(
			key === 'default'
				? `field.${helper} takes no default: no field has one, so write the default in code where the value is read, such as \`limit ?? 50\``
				: `field.${helper} takes no option "${key}"; it takes ${declared.join(', ')}`,
		);
	}
}

const OPTIONS = ['description', 'optional'] as const;
const BOUNDED = [...OPTIONS, 'min', 'max'] as const;

/**
 * One object whose keys are fields, as plain JSON Schema: each field under
 * `properties`, the keys a caller must give in `required` (`[]` when none
 * is), and `additionalProperties: false`. It is also the TypeBox schema
 * `Value.Check` validates with, and it survives `JSON.stringify` whole.
 */
export type ObjectSchema = {
	readonly type: 'object';
	readonly properties: Readonly<Record<string, TSchema>>;
	readonly required: string[];
	readonly additionalProperties: false;
};

/**
 * The `ObjectSchema` of `fields`. TypeBox marks an optional field with a
 * property `JSON.stringify` skips, so the one record of which keys are
 * required is `required`, written here once.
 */
export function objectSchema(fields: Record<string, TSchema>): ObjectSchema {
	const schema = Type.Object(fields, { additionalProperties: false });
	// TypeBox leaves `required` out when no key is; a reader should not have to know that.
	(schema as { required?: string[] }).required ??= [];
	return schema as unknown as ObjectSchema;
}

type Optionally<T extends TSchema, O> = O extends { optional: true }
	? TOptional<T>
	: T;

/** Whether a field may be absent from a record. */
export const isOptional = (schema: TSchema) =>
	(schema as { '~optional'?: boolean })['~optional'] === true;

/** The keys of `F` whose field may be absent. */
export type OptionalKeys<F> = {
	[K in keyof F]: F[K] extends { '~optional': true } ? K : never;
}[keyof F];

/** The JSON Schema keyword a reference carries: `{ "x-epicenter-ref": { "key": "<a data key>" } }`. */
const REF = 'x-epicenter-ref';

/** The data key named by a ref, or undefined for another field. */
export function refKeyOf(schema: unknown): string | undefined {
	if (typeof schema !== 'object' || schema === null) return undefined;
	const annotation = (schema as Record<string, unknown>)[REF];
	const key = (annotation as { key?: unknown } | undefined)?.key;
	return typeof key === 'string' ? key : undefined;
}

type ListOptions = Options & {
	/** The fewest items it holds. */
	min?: number;
};

function maybeOptional<T extends TSchema, O extends Options>(
	schema: T,
	options: O | undefined,
): Optionally<T, O> {
	return (options?.optional ? Type.Optional(schema) : schema) as Optionally<
		T,
		O
	>;
}

/** The schema options a field carries: its description. */
function schemaOptions(options: Options | undefined) {
	return options?.description === undefined
		? {}
		: { description: options.description };
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
	 * Text. `pattern` is a regular expression the value must contain a match
	 * of, as JSON Schema reads it: `'\\S'` is not blank, and `'^[A-Z]{3}$'`
	 * anchors it to the whole value. A refusal names the pattern, then the
	 * description: `body must be text matching \S (what to save)`.
	 */
	text: <const O extends Options & { pattern?: string }>(options?: O) => {
		only('text', options, [...OPTIONS, 'pattern']);
		return maybeOptional(
			Type.String({
				...schemaOptions(options),
				...(options?.pattern === undefined ? {} : { pattern: options.pattern }),
			}),
			options,
		);
	},

	/** A number, at least `min` and at most `max` when they are given. */
	number: <const O extends Options & Bounds>(options?: O) => {
		only('number', options, BOUNDED);
		return maybeOptional(
			Type.Number({ ...schemaOptions(options), ...bounds(options) }),
			options,
		);
	},

	/** A whole number, at least `min` and at most `max` when they are given. */
	integer: <const O extends Options & Bounds>(options?: O) => {
		only('integer', options, BOUNDED);
		return maybeOptional(
			Type.Integer({ ...schemaOptions(options), ...bounds(options) }),
			options,
		);
	},

	/** A moment, written RFC 3339 with an offset (`2026-11-10T22:41:05+08:00`): JSON Schema's `format: 'date-time'`. */
	datetime: <const O extends Options>(options?: O) => {
		only('datetime', options, OPTIONS);
		return maybeOptional(
			Type.String({ ...schemaOptions(options), format: 'date-time' }),
			options,
		);
	},

	/** A day, written `2026-11-08`: JSON Schema's `format: 'date'`, which TypeBox checks, so `2026-13-45` is refused. */
	date: <const O extends Options>(options?: O) => {
		only('date', options, OPTIONS);
		return maybeOptional(
			Type.String({ ...schemaOptions(options), format: 'date' }),
			options,
		);
	},

	/** One of `values`, as `field.select(['archive', 'trash'])`. */
	select: <
		const V extends readonly [string, ...string[]],
		const O extends Options,
	>(
		values: V,
		options?: O,
	) => {
		only('select', options, OPTIONS);
		return maybeOptional(
			Type.Union(
				values.map((value) => Type.Literal(value)),
				schemaOptions(options),
			) as unknown as TUnion<{ -readonly [K in keyof V]: TLiteral<V[K]> }>,
			options,
		);
	},

	/** True or false. */
	boolean: <const O extends Options>(options?: O) => {
		only('boolean', options, OPTIONS);
		return maybeOptional(Type.Boolean(schemaOptions(options)), options);
	},

	/**
	 * A list of any field: `field.list(field.select(['x', 'threads']))`.
	 * `{ min: 1 }` makes it need at least one item when it is given.
	 */
	list: <const T extends TSchema, const O extends ListOptions>(
		item: T,
		options?: O,
	) => {
		only('list', options, [...OPTIONS, 'min']);
		const min = options?.min ?? 0;
		return maybeOptional(
			Type.Array(item, {
				...schemaOptions(options),
				...(min > 0 ? { minItems: min } : {}),
			}),
			options,
		);
	},

	/**
	 * One id in a key of the same `defineData`, which may be any of its keys:
	 * text whose schema names that key. `defineData` refuses a key it does
	 * not define. Nothing checks that the record is there, so an app that
	 * needs it reads it.
	 */
	ref: <const O extends Options>(target: string, options?: O) => {
		only('ref', options, OPTIONS);
		return maybeOptional(
			Type.String({ ...schemaOptions(options), [REF]: { key: target } }),
			options,
		);
	},
};

/**
 * Why `value` does not fit `field`, named `name`: TypeBox's words after the
 * part at fault, such as `nights must be >= 1` or `meta.n must be number`.
 * A select names its choices, which TypeBox's words leave out.
 */
export function whyNot(name: string, field: TSchema, value: unknown) {
	const { anyOf } = field as { anyOf?: { const?: unknown }[] };
	if (anyOf?.every((choice) => typeof choice.const === 'string'))
		return `${name} must be one of ${anyOf.map((choice) => choice.const).join(', ')}`;
	const [error] = Value.Errors(field, value);
	const at = [name, ...(error?.instancePath.split('/').slice(1) ?? [])];
	return `${at.join('.')} ${error?.message ?? 'does not fit'}`;
}
