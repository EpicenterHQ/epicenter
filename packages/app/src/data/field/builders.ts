/**
 * The `field.*` authoring builders: the CONSTRUCTION half of the closed field
 * vocabulary. `recognize` (in `./field`) is the recognition half. They are
 * inverses over ONE wire-form: serialize a `field.X(...)` schema to its at-rest
 * JSON and `recognize` classifies it back to kind `X`. `field.test.ts` proves
 * the round-trip for every kind.
 *
 * Every builder is a thin composition of native TypeBox constructors that emit
 * the recognized wire-form directly:
 *
 *   field.select(['a','b'])      Type.Enum            -> {enum:['a','b']}        Static = 'a' | 'b'
 *   field.multiSelect(['a','b']) Type.Array(Type.Enum)-> {type:'array',items:{enum:[...]}}
 *   field.tags()                 Type.Array(Type.String) -> {type:'array',items:{type:'string'}}
 *   field.number/integer/boolean Type.Number/Integer/Boolean (full TypeBox JSDoc preserved)
 *
 * `Type.Enum` is the load-bearing choice: in TypeBox v1 it emits the native JSON
 * Schema `enum` keyword, infers `Static` as the literal union, and carries `enum`
 * at the type level, so authoring, recognition, and any SQL an application
 * derives all read one shape with no `Type.Unsafe` and no value-to-tuple
 * gymnastics.
 *
 * Branding still rides on `Type.Unsafe` for the cases that need a brand the
 * wire-form cannot express: `field.string<Brand>()`, `field.date()`,
 * `field.instant()`, and `field.datetime()`. `Type.Unsafe` decouples the emitted
 * JSON Schema from the inferred `Static<>`.
 *
 * NOTE on at-rest vs in-memory: a live TypeBox schema carries a non-enumerable
 * `~kind` tag that the CLOSED metas reject on a direct `recognize`. That tag is
 * dropped by JSON serialization, so the AT-REST form (what is stored on disk / in
 * Yjs and what `recognize` actually reads) classifies correctly. The round-trip
 * test serializes through JSON to mirror this.
 *
 * Closed sets are STRING-ONLY: `select` / `multiSelect` hold strings, not numbers
 * or booleans. A numeric range is an `integer` with `minimum` / `maximum`, not a
 * select. `json` is the one OPEN escape kind in the vocabulary: an arbitrary JSON
 * payload discriminated by the marker, not a `type`. Emptiness (`nullable`) is the
 * one axis NOT in the vocabulary: it is SUBSTRATE POLICY the workspace layers on with
 * its own standalone `nullable` wrapper, and matter forbids it. The vocabulary carries
 * kinds, never an emptiness policy.
 */

import {
	type Static,
	type TArray,
	type TEnum,
	type TSchema,
	type TSchemaOptions,
	type TString,
	type TStringOptions,
	type TUnsafe,
	Type,
} from 'typebox';
import type { Brand } from 'wellcrafted/brand';
import type { JsonValue } from 'wellcrafted/json';
import type { CalendarDateString } from './calendar-date-string.js';
import type { DateTimeString } from './datetime-string.js';
import { JSON_SCHEMA_KEYWORD, REFERENCE_KEYWORD } from './field.js';
import {
	INSTANT_STRING_PATTERN,
	type InstantString,
} from './instant-string.js';

type BrandedString = string & Brand<string>;
type StringOptions = TStringOptions & {
	/** Maximum UTF-8 bytes in the stored string. */
	maxBytes?: number;
};

/**
 * String field with optional brand sugar.
 *
 * - `field.string()` -> `TString`, `Static<>` = `string`.
 * - `field.string<NoteId>()` -> `TUnsafe<NoteId>`, `Static<>` = `NoteId`.
 * - `field.string<'draft'>()` -> `never` (compile-time): pretending a literal
 *   subtype is enforced at runtime is dishonest; use `field.select(['draft'])`.
 */
function string<T extends string = string>(
	opts?: StringOptions,
): string extends T ? TString : T extends BrandedString ? TUnsafe<T> : never {
	return Type.String(opts) as string extends T
		? TString
		: T extends BrandedString
			? TUnsafe<T>
			: never;
}

/**
 * Cross-row reference field: a string value that points at a row in another table.
 *
 * - `field.reference('pages')` -> `TUnsafe<string>`, `Static<>` = `string`.
 * - `field.reference<PageId>('pages')` -> `TUnsafe<PageId>`, `Static<>` = `PageId`.
 * - `field.reference<'draft'>('x')` -> `never` (compile-time), for the same reason
 *   `field.string<'draft'>()` is: a literal subtype is not enforced at runtime.
 *
 * The VALUE is the target row's stem / id; the `table` argument is recorded in the
 * at-rest schema under {@link REFERENCE_KEYWORD} so `recognize` classifies the field as
 * kind `reference` and recovers its target. This composes the two existing tricks:
 * `Type.Unsafe` carries the brand on `Static<>` (as in {@link string}) while the marker
 * rides on the emitted wire-form (as in {@link json}). It is ALWAYS `TUnsafe` (even
 * unbranded), because the marker-bearing wire-form must be decoupled from the inferred
 * `Static<>`. Value validation is plain-string (the marker is non-standard, so
 * `Value.Check` ignores it); whether the target ROW exists is cross-table integrity,
 * enforced outside this leaf.
 *
 * The brand is type-safe at the call site; the `table` STRING is not (the field is
 * authored before its workspace knows the full table set), so a dangling target is caught
 * at workspace construction, not here.
 */
function reference<T extends string = string>(
	table: string,
	opts?: StringOptions,
): string extends T
	? TUnsafe<string>
	: T extends BrandedString
		? TUnsafe<T>
		: never {
	return Type.Unsafe({
		...Type.String(opts),
		[REFERENCE_KEYWORD]: table,
	}) as string extends T
		? TUnsafe<string>
		: T extends BrandedString
			? TUnsafe<T>
			: never;
}

/**
 * URL string field. A `TString` carrying `format: 'uri'` as a hint, so the schema
 * is self-describing and editor tooling can surface it. Static type is `string`
 * (no brand). When the `uri` format is not registered with the runtime validator,
 * `Value.Check` treats it as a pass, so this never rejects a value the rest of the
 * system would accept.
 */
function url(opts?: TStringOptions): TString {
	return Type.String({ format: 'uri', ...opts });
}

/** Pass-through to `Type.Number`, exposed as `field.number`. */
const number = Type.Number;

/** Pass-through to `Type.Integer`. */
const integer = Type.Integer;

/** Pass-through to `Type.Boolean`. */
const boolean = Type.Boolean;

/**
 * ISO calendar day, branded as `CalendarDateString`.
 *
 * Uses TypeBox v1's built-in `date` format validator. Carries no time, offset,
 * or time zone meaning. Stored as `YYYY-MM-DD`, which sorts naturally as TEXT.
 */
function date(opts?: TSchemaOptions): TUnsafe<CalendarDateString> {
	return Type.Unsafe<CalendarDateString>(
		Type.String({ ...opts, format: 'date' }),
	);
}

/**
 * Canonical UTC instant, branded as `InstantString`.
 *
 * This is stricter than `field.datetime()`: it requires the exact fixed-width
 * `YYYY-MM-DDTHH:mm:ss.sssZ` form. The fixed UTC form is why SQLite TEXT order
 * matches chronological order.
 */
function instant(opts?: TSchemaOptions): TUnsafe<InstantString> {
	return Type.Unsafe<InstantString>(
		Type.String({
			...opts,
			format: 'date-time',
			pattern: INSTANT_STRING_PATTERN,
		}),
	);
}

/**
 * RFC 3339 / ISO 8601 datetime string, branded as `DateTimeString`.
 *
 * Uses TypeBox v1's built-in `date-time` format validator (auto-registered; no
 * `Format.Set` required). Accepts both Z (`...Z`) and offset (`...±HH:MM`) forms.
 * `Type.Unsafe` carries the brand on `Static<>` while emitting the plain
 * `{type:'string', format:'date-time'}` wire-form that `recognize` reads.
 */
function datetime(opts?: TSchemaOptions): TUnsafe<DateTimeString> {
	return Type.Unsafe<DateTimeString>(
		Type.String({ format: 'date-time', ...opts }),
	);
}

/**
 * Closed-set field over a fixed list of string members. A typed narrowing of
 * `Type.Enum`: it emits the native `{enum:[...]}` wire-form `recognize`
 * classifies as `select`, infers `Static` as the literal union (`'a' | 'b'`),
 * and keeps the members on the type so a derived SQL column reads them
 * structurally. String-only by design: a numeric range is an `integer` with
 * `minimum` / `maximum`, not a select.
 *
 * The `readonly [...T]` variadic mirrors `Type.Enum`'s own parameter, so the
 * literal tuple flows through with NO cast; the narrower `readonly string[]`
 * bound assigns cleanly because `Type.Enum` accepts a superset. An empty list
 * yields `{enum:[]}`, which `recognize` rejects (the field degrades to raw),
 * matching the uniform "unrecognized schema degrades" contract.
 */
const select: <const T extends readonly string[]>(
	values: readonly [...T],
	opts?: TSchemaOptions,
) => TEnum<[...T]> = Type.Enum;

/**
 * List of closed-set members: an array of the same native `enum` shape `select`
 * emits. Recognizes as `multiSelect`. `Static<>` is the array of the literal
 * union (`('a' | 'b')[]`). Composing the typed `select` (whose declared return
 * threads `T`) keeps this cast-free; the list refinements (`minItems` /
 * `maxItems` / `uniqueItems`) ride on the array via `opts`.
 */
const multiSelect = <const T extends readonly string[]>(
	values: readonly [...T],
	opts?: TSchemaOptions,
): TArray<TEnum<[...T]>> => Type.Array(select(values), opts);

/**
 * List of free-form strings: `{type:'array', items:{type:'string'}}`. Recognizes
 * as `tags`. `Static<>` is `string[]`.
 */
const tags = (opts?: TSchemaOptions) => Type.Array(Type.String(), opts);

/**
 * The canonical "any JSON value" schema: `Static<> = JsonValue`, runtime accepts any
 * value. Reach for it when a payload is genuinely shapeless: pass it straight
 * (`field.json(jsonValue)` for an opaque cell) or as an element type
 * (`field.json(Type.Array(jsonValue))` for a list of arbitrary JSON). It replaces
 * the hand-rolled `Type.Unsafe<JsonValue>(Type.Any())` that several apps had each spelled
 * a slightly different way.
 *
 * `Type.Unsafe` pins `Static<>` to wellcrafted's canonical `JsonValue` while the runtime
 * schema stays `Type.Any()` (wire-form `{}`). JSON-ness is enforced at the TYPE level by
 * `FlatJsonTSchema` at the `defineTable` boundary, NOT by a runtime check here, and that
 * is deliberate: TypeBox's `Value.Check` is structural, so even a recursive JSON schema
 * (`Type.Cyclic`) cannot reject a `Date` (it reads as an empty object). A recursive runtime
 * schema would add wire-form weight without adding safety, and the `x-json-schema` marker
 * already declares the cell as arbitrary JSON, so `Type.Any()` is the honest floor.
 */
export const jsonValue: TUnsafe<JsonValue> = Type.Unsafe<JsonValue>(Type.Any());

/**
 * Arbitrary JSON payload, stored as TEXT, recognized as kind `json`.
 *
 * `field.json(inner)` -> `Static<> = Static<inner>`, validates the payload against
 * `inner` on read. For a genuinely shapeless cell, pass {@link jsonValue}
 * (`field.json(jsonValue)`): "any JSON" is not a special case, just the `inner = jsonValue`
 * instance of the general form, so it takes the same one signature with no overload.
 *
 * The wire-form SPREADS the payload's own JSON Schema keywords (so `Value.Check` and
 * `Schema.Compile` enforce them) and adds the {@link JSON_SCHEMA_KEYWORD} marker, so
 * `recognize` classifies it as `json` instead of the bare object/array it would otherwise
 * look like (which would degrade to raw). `Type.Unsafe<Static<S>>` decouples the inferred
 * `Static<>` from that marker-bearing wire-form while letting the payload generic flow
 * straight through to the return type.
 *
 * No JSON-safety gate lives here (that would pull the workspace's `ColumnError` into the
 * leaf): a non-JSON inner (e.g. `Type.Date`) flows through as `TUnsafe<Date>` and is caught
 * by `FlatJsonTSchema` at the `defineTable` boundary, where field safety belongs.
 */
type TJson<S extends TSchema> = TUnsafe<Static<S>> & {
	// Keep the real wire marker visible to schema-aware type consumers while
	// `Static<TJson<S>>` remains exactly `Static<S>` for ordinary application data.
	readonly [JSON_SCHEMA_KEYWORD]: true;
};

function json<S extends TSchema>(inner: S): TJson<S> {
	return Type.Unsafe<Static<S>>({
		...inner,
		[JSON_SCHEMA_KEYWORD]: true,
	}) as TJson<S>;
}

/**
 * The `field.*` namespace: the one blessed way to construct a schema in the recognized
 * vocabulary. Each builder emits the wire-form its kind's meta reads, so `recognize` is
 * its inverse. `json` is the arbitrary-JSON escape kind (marker-discriminated). The
 * emptiness AXIS (`nullable`) is NOT a kind and lives in the workspace, not here.
 */
export const field = {
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
};
