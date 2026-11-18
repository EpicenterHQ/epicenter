/**
 * The fields a data file and an action's input are made of. Each is
 * a TypeBox schema, which is JSON Schema, so raw TypeBox sits beside them.
 * Every caller gives an action's input as one JSON object whose keys are its
 * fields; MCP shows each as a property of the tool's input.
 *
 * A field is required unless it says `optional`. A switch (`boolean`) is
 * never required, and an absent one is `false`. A list (`list`) is not
 * required, and an absent one is empty, unless it says `min` of 1 or more:
 * then `[]` would not fit, so it is required like any other field. That is a
 * rule of these two helpers, which mark their schema with its kind
 * (`absentValue`); no field carries a JSON Schema `default`, and a definition
 * that has one is refused (`defaultIn`). Fields describe data; an action
 * declares private input handling separately.
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
};

type MaybeOptional = Options & { optional?: boolean };

/** `O`, with each option `Allowed` does not declare typed `never`, so `field.integer({ default: 50 })` is a type error. */
type Only<O, Allowed> = O & { [K in Exclude<keyof O, keyof Allowed>]: never };

/**
 * Throw when `options` names one `helper` does not declare, so it is never
 * dropped without a word. A `default` gets its own sentence: no field has one.
 */
function only(
	helper: string,
	options: object | undefined,
	declared: readonly string[],
): void {
	for (const key of Object.keys(options ?? {})) {
		if (declared.includes(key)) continue;
		throw new Error(
			key === 'default'
				? `field.${helper} takes no default: no field has one, so write the default in code where the value is read, such as \`limit ?? 50\``
				: `field.${helper} takes no option "${key}"; it takes ${declared.join(', ')}`,
		);
	}
}

const OPTIONS = ['description'] as const;
const MAYBE_OPTIONAL = [...OPTIONS, 'optional'] as const;
const BOUNDED = [...MAYBE_OPTIONAL, 'min', 'max'] as const;

/**
 * The JSON Schema keyword `field.boolean` and `field.list` mark their schema
 * with: `"x-epicenter-field": "switch"` or `"list"`. It names the field's
 * kind, not a value; `absentValue` holds what that kind means when absent.
 */
const KIND = 'x-epicenter-field';

/**
 * What a field reads as when its key is absent: `false` for `field.boolean`,
 * `[]` for a `field.list` with no `min`, and `undefined` for every other
 * field, a list that needs an item included. A read of a file and a call of
 * an action both use it, so the two agree.
 */
export function absentValue(schema: unknown): false | [] | undefined {
	if (typeof schema !== 'object' || schema === null) return undefined;
	const { [KIND]: kind, minItems } = schema as Record<string, unknown>;
	if (kind === 'switch') return false;
	if (kind === 'list' && !minItems) return [];
	return undefined;
}

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
 * required is `required`, written here once (ADR-0953).
 */
export function objectSchema(fields: Record<string, TSchema>): ObjectSchema {
	const schema = Type.Object(fields, { additionalProperties: false });
	// TypeBox leaves `required` out when no key is; a reader should not have to know that.
	(schema as { required?: string[] }).required ??= [];
	return schema as unknown as ObjectSchema;
}

/** Keywords whose value is data, not a schema, so a `default` key inside it is a value. */
const DATA_KEYWORDS = new Set(['const', 'enum', 'examples']);

/** Keywords whose value maps names to schemas, so a key `default` there is a name. */
const NAMED_SCHEMAS = new Set([
	'properties',
	'patternProperties',
	'$defs',
	'definitions',
	'dependentSchemas',
]);

/** Whether `schema` has a JSON Schema `default` at any depth. */
export function defaultIn(schema: unknown): boolean {
	if (Array.isArray(schema)) return schema.some(defaultIn);
	if (typeof schema !== 'object' || schema === null) return false;
	if (Object.hasOwn(schema, 'default')) return true;
	return Object.entries(schema).some(([key, value]) =>
		DATA_KEYWORDS.has(key)
			? false
			: NAMED_SCHEMAS.has(key) && typeof value === 'object' && value !== null
				? Object.values(value).some(defaultIn)
				: defaultIn(value),
	);
}

type Optionally<T extends TSchema, O> = O extends { optional: true }
	? TOptional<T>
	: T;

/**
 * The keys of `F` that are a switch or a list that may be empty, which a read
 * and an action's `run` always have. A list with a `min` is required, so it is
 * there as any required field is.
 */
export type FilledKeys<F> = {
	[K in keyof F]: F[K] extends { [KIND]: 'switch' | 'list'; '~optional': true }
		? K
		: never;
}[keyof F];

/** A switch: `false` unless its key is given, or is in the file. */
export type TSwitch = TOptional<TBoolean> & { [KIND]: 'switch' };

/** A list of `T`: empty unless given. */
export type TList<T extends TSchema> = TOptional<TArray<T>> & {
	[KIND]: 'list';
};

/** The JSON Schema keyword a reference carries: `{ "x-epicenter-ref": { "key": "<a folder key>" } }`. */
const REF = 'x-epicenter-ref';

/** A data ref retains its target key for declaration-time checking. */
type RefSchema<TTarget extends string> = TString & { [REF]: { key: TTarget } };

/** The folder key named by a data ref, or undefined for another field. */
export function refKeyOf(schema: unknown): string | undefined {
	if (typeof schema !== 'object' || schema === null) return undefined;
	const annotation = (schema as Record<string, unknown>)[REF];
	const key = (annotation as { key?: unknown } | undefined)?.key;
	return typeof key === 'string' ? key : undefined;
}

/** A list that needs at least one item: required, and never filled when absent. */
export type TRequiredList<T extends TSchema> = TArray<T> & { [KIND]: 'list' };

type ListOptions = Options & {
	/** The fewest items it holds; 1 or more makes it required, since `[]` would not fit. */
	min?: number;
};

/** A list of `item`: optional and empty unless given, or required with at least `min` items. */
function list<const T extends TSchema, const O extends ListOptions>(
	item: T,
	options?: Only<O, ListOptions>,
) {
	only('list', options, [...OPTIONS, 'min']);
	const min = options?.min ?? 0;
	if (!Number.isInteger(min) || min < 0)
		throw new Error(
			`field.list's min must be a whole number of at least 0, not ${min}`,
		);
	const array = Type.Array(item, {
		...schemaOptions(options),
		...(min > 0 ? { minItems: min } : {}),
		[KIND]: 'list',
	});
	return (min > 0 ? array : Type.Optional(array)) as unknown as O extends {
		min: infer M extends number;
	}
		? M extends 0
			? TList<T>
			: TRequiredList<T>
		: TList<T>;
}

function maybeOptional<T extends TSchema, O extends MaybeOptional>(
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
	 * Text. `pattern` is a regular expression the whole value must match; give
	 * a `description` that reads after "must be", since that is how a refusal
	 * names it: `{ pattern: '^\\S.*$', description: 'one line, not blank' }`.
	 */
	text: <const O extends MaybeOptional & { pattern?: string }>(
		options?: Only<O, MaybeOptional & { pattern?: string }>,
	) => {
		only('text', options, [...MAYBE_OPTIONAL, 'pattern']);
		return maybeOptional(
			Type.String({
				...schemaOptions(options),
				...(options?.pattern === undefined ? {} : { pattern: options.pattern }),
			}),
			options,
		);
	},

	/** A number, at least `min` and at most `max` when they are given. */
	number: <const O extends MaybeOptional & Bounds>(
		options?: Only<O, MaybeOptional & Bounds>,
	) => {
		only('number', options, BOUNDED);
		return maybeOptional(
			Type.Number({ ...schemaOptions(options), ...bounds(options) }),
			options,
		);
	},

	/** A whole number, at least `min` and at most `max` when they are given. */
	integer: <const O extends MaybeOptional & Bounds>(
		options?: Only<O, MaybeOptional & Bounds>,
	) => {
		only('integer', options, BOUNDED);
		return maybeOptional(
			Type.Integer({ ...schemaOptions(options), ...bounds(options) }),
			options,
		);
	},

	/** A moment, written RFC 3339 with an offset (`2026-11-10T22:41:05+08:00`): JSON Schema's `format: 'date-time'`. */
	datetime: <const O extends MaybeOptional>(
		options?: Only<O, MaybeOptional>,
	) => {
		only('datetime', options, MAYBE_OPTIONAL);
		return maybeOptional(
			Type.String({ ...schemaOptions(options), format: 'date-time' }),
			options,
		);
	},

	/** A day, written `2026-11-08`: JSON Schema's `format: 'date'`, which TypeBox checks, so `2026-13-45` is refused. */
	date: <const O extends MaybeOptional>(options?: Only<O, MaybeOptional>) => {
		only('date', options, MAYBE_OPTIONAL);
		return maybeOptional(
			Type.String({ ...schemaOptions(options), format: 'date' }),
			options,
		);
	},

	/** One of `values`, as `field.select(['archive', 'trash'])`. */
	select: <
		const V extends readonly [string, ...string[]],
		const O extends MaybeOptional,
	>(
		values: V,
		options?: Only<O, MaybeOptional>,
	) => {
		only('select', options, MAYBE_OPTIONAL);
		return maybeOptional(
			Type.Union(
				values.map((value) => Type.Literal(value)),
				schemaOptions(options),
			) as unknown as TUnion<{ -readonly [K in keyof V]: TLiteral<V[K]> }>,
			options,
		);
	},

	/** A switch: `false` unless given, and never required. */
	boolean: <const O extends Options>(options?: Only<O, Options>) => {
		only('boolean', options, OPTIONS);
		return Type.Optional(
			Type.Boolean({ ...schemaOptions(options), [KIND]: 'switch' }),
		) as unknown as TSwitch;
	},

	/**
	 * A list of any field: `field.list(field.select(['x', 'threads']))`. It is
	 * not required, and reads as `[]` when absent. `{ min: 1 }` makes it need
	 * at least one item: then it is required, and an absent one is missing.
	 */
	list,

	/**
	 * One id in a folder key of the same `defineData`: text that `check`
	 * confirms names a file there. Reads open no other file.
	 */
	ref: <const TTarget extends string, const O extends MaybeOptional>(
		target: TTarget,
		options?: Only<O, MaybeOptional>,
	) => {
		only('ref', options, MAYBE_OPTIONAL);
		return maybeOptional(
			Type.String({
				...schemaOptions(options),
				[REF]: { key: target },
			}) as RefSchema<TTarget>,
			options,
		);
	},
};

type Described = {
	type?: string;
	format?: string;
	pattern?: string;
	description?: string;
	minimum?: number;
	maximum?: number;
	minItems?: number;
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
	'minItems',
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
	if (schema.type === 'array') {
		const each = schema.items && wanted(schema.items);
		const min = schema.minItems ?? 0;
		const atLeast =
			min > 0 ? `at least ${min} item${min === 1 ? '' : 's'}` : '';
		if (each === 'text')
			return atLeast ? `a list of text with ${atLeast}` : 'a list of text';
		const list = atLeast ? `a list of ${atLeast}` : 'a list';
		return each ? `${list}, each ${each}` : list;
	}
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
 * What a field takes, in the words `whatFits` refuses with, such as `text` or
 * `a day like 2026-11-12`, ending `, or null` for one that takes `null`. The
 * command line's `--help` says it of each key.
 */
export function whatTakes(field: TSchema): string {
	const nonNull = withoutNull(field);
	// A pattern's words are the field's description, which help prints beside these.
	const { pattern: _, ...schema } = nonNull as Described;
	const words = wanted(schema) ?? 'any JSON value';
	return nonNull === field ? words : `${words}, or null`;
}

/**
 * What a field takes, in words such as `a day like 2026-11-12` or `a whole
 * number from 1 to 5`, when `value` does not fit it for a reason those words
 * say; `undefined` when it fits, or when they would not say why (a text too
 * long). A call says it of an input's key and a data read of a file's front
 * matter, so both say it alike.
 */
export function whatFits(field: TSchema, value: unknown): string | undefined {
	if (Value.Check(field, value)) return undefined;
	const schema = withoutNull(field);
	const [error] = Value.Errors(schema, value);
	if (!error || !SAID.has(error.keyword)) return undefined;
	return wanted(schema as Described);
}
