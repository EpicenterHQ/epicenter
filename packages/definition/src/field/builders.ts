/**
 * The `field.*` helpers: ergonomic wrappers over native TypeBox schemas.
 *
 * Each helper returns a native schema, so `Static`, `Compile`, and
 * `Value.Check` read it directly, and annotates it with the editor it is meant
 * to get (see `./editor`):
 *
 *   field.select(['a', 'b'])   Type.Enum(['a', 'b'])              { kind: 'select' }
 *   field.reference('pages')   Type.String({ minLength: 1 })      { kind: 'reference', target: 'pages' }
 *   field.json(schema)         a copy of schema                   { kind: 'json' }
 *   field.nullable(inner)      Type.Union([inner, Type.Null()])   no hint of its own
 *   field.optional(inner)      Type.Optional(inner)               inner's hint
 *
 * A helper is a convenience, not a gate. A declaration takes any native
 * schema, and a bare `Type.Object(...)` is a field with the JSON editor.
 *
 * Helpers add portable keywords and editor hints, and nothing else. A field
 * is JSON: preparation refuses a native callback, a codec, or a refinement,
 * because a declaration is also written to a file that must validate the same
 * way.
 *
 * A helper takes only the options listed in its type and refuses any other
 * key, so an option cannot replace the `type`, `format`, or hint the helper
 * sets. It copies what it is given: changing an options object, an option
 * list, or a wrapped schema after the call changes nothing here.
 *
 * Helpers return native schema objects. Copies retain the input's property
 * descriptors. `prepareDefinition` takes ownership by returning a frozen
 * snapshot. Editing a helper's schema natively before then is the author's
 * edit to make, and the editor follows the edited schema.
 *
 * Closed sets hold strings. A numeric range is an `integer` with `minimum`
 * and `maximum`, not a select.
 */

import {
	type Static,
	type TArray,
	type TBoolean,
	type TEnum,
	type TInteger,
	type TNull,
	type TNumber,
	type TOptional,
	type TSchema,
	type TString,
	type TUnion,
	type TUnsafe,
	Type,
} from 'typebox';
import { Memory } from 'typebox/system';
import type { Brand } from 'wellcrafted/brand';
import type { JsonValue } from 'wellcrafted/json';
import { isTableName } from '../table-name.js';
import type { CalendarDateString } from './calendar-date-string.js';
import type { DateTimeString } from './datetime-string.js';
import { type Annotated, annotate, type Kind } from './editor.js';
import {
	INSTANT_STRING_PATTERN,
	type InstantString,
} from './instant-string.js';

/** A helper's hint: its kind, and what the kind adds. */
type Hint<K extends Kind, TExtra = unknown> = { readonly kind: K } & TExtra;

type Annotations = {
	/** A short label for the field. */
	title?: string;
	/** What the field holds. */
	description?: string;
};

type StringOptions = Annotations & {
	minLength?: number;
	maxLength?: number;
	pattern?: string;
};

type NumberOptions = Annotations & { minimum?: number; maximum?: number };

type ListOptions = Annotations & {
	minItems?: number;
	maxItems?: number;
	uniqueItems?: boolean;
};

const ANNOTATIONS = ['title', 'description'] as const;
const STRING = [...ANNOTATIONS, 'minLength', 'maxLength', 'pattern'] as const;
const NUMBER = [...ANNOTATIONS, 'minimum', 'maximum'] as const;
const LIST = [...ANNOTATIONS, 'minItems', 'maxItems', 'uniqueItems'] as const;

/**
 * The options a helper passes to TypeBox, copied.
 *
 * TypeBox merges options over the keywords a constructor sets, so an
 * unchecked `type` or `format` would replace the helper's. An unsupported key
 * throws rather than being dropped: a declaration that asks for something the
 * helper will not do should not load.
 */
function supported<TOptions extends object, TKey extends keyof TOptions>(
	helper: string,
	opts: TOptions | undefined,
	keys: readonly TKey[],
): Pick<TOptions, TKey> {
	const picked: Partial<Pick<TOptions, TKey>> = {};
	for (const key of Object.keys(opts ?? {})) {
		if (!(keys as readonly string[]).includes(key))
			throw new TypeError(
				`field.${helper} does not support the '${key}' option`,
			);
		const value = (opts as TOptions)[key as TKey];
		if (value !== undefined) picked[key as TKey] = value;
	}
	return picked as Pick<TOptions, TKey>;
}

/**
 * The native string schema behind `field.string` and `field.reference`.
 * `minLength` is the helper's floor; a larger declared one is kept.
 */
function stringSchema(
	helper: string,
	opts: StringOptions | undefined,
	minLength: number,
): TString {
	const options = supported(helper, opts, STRING);
	const floor = Math.max(minLength, options.minLength ?? 0);
	return Type.String(floor === 0 ? options : { ...options, minLength: floor });
}

type BrandedString = string & Brand<string>;

/** `TString`, or a schema whose `Static` is the brand `T`. A literal subtype is `never`. */
type StringSchema<T extends string> = string extends T
	? TString
	: T extends BrandedString
		? TUnsafe<T>
		: never;

/**
 * String field with optional brand sugar.
 *
 * - `field.string()`: `Static<>` = `string`.
 * - `field.string<NoteId>()`: `Static<>` = `NoteId`.
 * - `field.string<'draft'>()`: `never`. A literal subtype is not enforced at
 *   runtime; use `field.select(['draft'])`.
 */
function string<T extends string = string>(
	opts?: StringOptions,
): Annotated<StringSchema<T>, Hint<'string'>> {
	return annotate(stringSchema('string', opts, 0), { kind: 'string' });
}

/**
 * A string that names a row in `table`. Brands like {@link string}.
 *
 * The value is never empty, because the empty string names no row; a larger
 * `minLength` is kept. The target is an editor hint and must be a usable table
 * name. Nothing checks that the table or the row exists, so a stored
 * identifier may dangle.
 */
function reference<
	T extends string = string,
	const TTable extends string = string,
>(
	table: TTable,
	opts?: StringOptions,
): Annotated<StringSchema<T>, Hint<'reference', { readonly target: TTable }>> {
	if (typeof table !== 'string' || !isTableName(table))
		throw new TypeError('field.reference needs the name of a table');
	return annotate(stringSchema('reference', opts, 1), {
		kind: 'reference',
		target: table,
	});
}

/** URL string, checked with TypeBox's `uri` format. */
function url(opts?: Annotations): Annotated<TString, Hint<'url'>> {
	return annotate(
		Type.String({ ...supported('url', opts, ANNOTATIONS), format: 'uri' }),
		{ kind: 'url' },
	);
}

/** Any finite number. */
function number(opts?: NumberOptions): Annotated<TNumber, Hint<'number'>> {
	return annotate(Type.Number(supported('number', opts, NUMBER)), {
		kind: 'number',
	});
}

/** A whole number. A rating is `field.integer({ minimum: 1, maximum: 5 })`. */
function integer(opts?: NumberOptions): Annotated<TInteger, Hint<'integer'>> {
	return annotate(Type.Integer(supported('integer', opts, NUMBER)), {
		kind: 'integer',
	});
}

function boolean(opts?: Annotations): Annotated<TBoolean, Hint<'boolean'>> {
	return annotate(Type.Boolean(supported('boolean', opts, ANNOTATIONS)), {
		kind: 'boolean',
	});
}

/**
 * ISO calendar day, branded as `CalendarDateString`.
 *
 * Carries no time, offset, or time zone. Stored as `YYYY-MM-DD`, which sorts
 * as text.
 */
function date(
	opts?: Annotations,
): Annotated<TUnsafe<CalendarDateString>, Hint<'date'>> {
	return annotate(
		Type.String({ ...supported('date', opts, ANNOTATIONS), format: 'date' }),
		{ kind: 'date' },
	);
}

/**
 * Canonical UTC instant, branded as `InstantString`.
 *
 * Stricter than `field.datetime()`: it requires the fixed-width
 * `YYYY-MM-DDTHH:mm:ss.sssZ` form, which is why text order is chronological
 * order.
 */
function instant(
	opts?: Annotations,
): Annotated<TUnsafe<InstantString>, Hint<'instant'>> {
	return annotate(
		Type.String({
			...supported('instant', opts, ANNOTATIONS),
			format: 'date-time',
			pattern: INSTANT_STRING_PATTERN,
		}),
		{ kind: 'instant' },
	);
}

/**
 * RFC 3339 datetime string, branded as `DateTimeString`. Accepts both `Z` and
 * offset forms.
 */
function datetime(
	opts?: Annotations,
): Annotated<TUnsafe<DateTimeString>, Hint<'datetime'>> {
	return annotate(
		Type.String({
			...supported('datetime', opts, ANNOTATIONS),
			format: 'date-time',
		}),
		{ kind: 'datetime' },
	);
}

/** A copy of an option list, so the caller's array is not involved after the call. */
function optionList<const T extends readonly string[]>(
	helper: string,
	values: readonly [...T],
): [...T] {
	if (
		!Array.isArray(values) ||
		values.length === 0 ||
		!values.every((value) => typeof value === 'string')
	)
		throw new TypeError(`field.${helper} needs at least one string option`);
	return [...values] as [...T];
}

/**
 * One of a fixed list of strings. `Static<>` is the literal union
 * (`'a' | 'b'`), and the options an editor offers are the schema's `enum`.
 */
function select<const T extends readonly string[]>(
	values: readonly [...T],
	opts?: Annotations,
): Annotated<TEnum<[...T]>, Hint<'select'>> {
	return annotate(
		Type.Enum(
			optionList('select', values),
			supported('select', opts, ANNOTATIONS),
		),
		{ kind: 'select' },
	);
}

/**
 * Any number of a fixed list of strings. `Static<>` is `('a' | 'b')[]`, and
 * the options an editor offers are the schema's `items.enum`.
 */
function multiSelect<const T extends readonly string[]>(
	values: readonly [...T],
	opts?: ListOptions,
): Annotated<TArray<TEnum<[...T]>>, Hint<'multiSelect'>> {
	return annotate(
		Type.Array(
			Type.Enum(optionList('multiSelect', values)),
			supported('multiSelect', opts, LIST),
		),
		{ kind: 'multiSelect' },
	);
}

/** A list of free-form strings. `Static<>` is `string[]`. */
function tags(opts?: ListOptions): Annotated<TArray<TString>, Hint<'tags'>> {
	return annotate(Type.Array(Type.String(), supported('tags', opts, LIST)), {
		kind: 'tags',
	});
}

/**
 * The "any JSON value" schema: `Static<>` is `JsonValue`.
 *
 * At runtime it is `Type.Any()` and checks nothing. A compiled field holds
 * every value to JSON before its schema runs, which is what makes the static
 * type true of a stored value. Use it bare, under `field.json`, or nested:
 * `Type.Array(jsonValue)`.
 */
export const jsonValue: TUnsafe<JsonValue> = Type.Unsafe<JsonValue>(Type.Any());

/**
 * A schema is an object. TypeBox's `TSchema` is an empty interface, which a
 * string or a number satisfies, so the helpers that take a schema say so.
 */
function isSchema(value: unknown): value is TSchema & object {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `inner`, edited as JSON: a copy of the schema with the JSON editor hint.
 *
 * `inner` is any native schema and `Static<>` is `Static<inner>`. The copy
 * keeps every keyword, so `inner`'s own errors are reported. Another field
 * works too:
 * `field.json(field.select([...]))` keeps the select's check and swaps its
 * editor for the JSON one.
 *
 * A bare native schema already gets the JSON editor, so this helper adds no
 * validation. It says the JSON editor is the intent, and it replaces a hint
 * that would have chosen another one.
 */
function json<S extends TSchema & object>(
	inner: S,
): Annotated<TUnsafe<Static<S>>, Hint<'json'>> {
	if (!isSchema(inner)) throw new TypeError('field.json needs a schema');
	if (Type.IsOptional(inner))
		throw new TypeError(
			'field.json takes a required schema; write field.optional(field.json(inner))',
		);
	return annotate(inner, { kind: 'json' });
}

/**
 * A field that may also hold `null`: `Type.Union([inner, Type.Null()])`, with
 * `Static<>` = `Static<inner> | null`, brands included.
 *
 * `inner` is any native schema. The union carries no hint of its own: `inner`
 * keeps its hint as a member, and the editor is resolved through the union, so
 * a nullable select is still a select. `null` is a stored value; absence is
 * {@link optional}. Optionality belongs to the field, so wrap
 * `field.optional` outside: `field.optional(field.nullable(inner))`.
 */
function nullable<S extends TSchema & object>(inner: S): TUnion<[S, TNull]> {
	if (!isSchema(inner)) throw new TypeError('field.nullable needs a schema');
	if (Type.IsOptional(inner))
		throw new TypeError(
			'field.nullable takes a required schema; write field.optional(field.nullable(inner))',
		);
	return Type.Union([Memory.Clone(inner) as S, Type.Null()]);
}

/**
 * A field a row may leave out: `Type.Optional(inner)`, read as `field?:` by
 * `RowOf` and `CreateRowOf`, and left out of the declaration's `required`
 * list. An absent optional field is not an issue; a present one is checked
 * against `inner`. `undefined` is absence, never a stored value.
 *
 * Absent and `null` stay distinct: `field.optional(field.nullable(inner))`
 * allows both. Every field of the `settings` table is one.
 */
function optional<S extends TSchema & object>(inner: S): TOptional<S> {
	if (!isSchema(inner)) throw new TypeError('field.optional needs a schema');
	return Type.Optional(Memory.Clone(inner) as S) as TOptional<S>;
}

/** The field namespace: the helpers for declaring a field. */
export const field = Object.freeze({
	string,
	reference,
	url,
	number,
	integer,
	boolean,
	date,
	instant,
	datetime,
	select,
	multiSelect,
	tags,
	json,
	nullable,
	optional,
});
