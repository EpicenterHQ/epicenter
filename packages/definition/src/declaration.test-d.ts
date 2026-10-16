/**
 * Compile-time type tests for declarations. Compiled by `tsc --noEmit`
 * alongside the rest of the package; nothing runs at test time.
 *
 * What these prove: a field map takes any native TypeBox schema, annotated or
 * not, and the row lenses read each one's exact `Static<>`. Helpers and raw
 * schemas sit side by side. A `field.optional` field is `name?:` in a row and
 * in the values that create one, as every field of the `settings` table is.
 * The reserved-name rule holds, a primitive is not a schema, and a native
 * `default` annotation is admitted without making a field optional.
 * `prepareSchema` returns the type it was given.
 *
 * A refinement or codec declared as a field is refused by its type here, and
 * one nested inside another schema by preparation at run time (see
 * `prepare.test.ts`).
 *
 * See `./field/field.test-d.ts` for the helpers' own types.
 */

import { type Static, Type } from 'typebox';
import type { Brand } from 'wellcrafted/brand';
import {
	type CreateRowOf,
	type DataSchema,
	defineTable,
	type FieldMap,
	field,
	type InstantString,
	type JsonValue,
	jsonValue,
	prepareSchema,
	type RowOf,
} from './index.js';

type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: { expected: Y; got: X };
type Expect<T extends true> = T;

type NoteId = string & Brand<'NoteId'>;

const Node = Type.Cyclic(
	{
		Node: Type.Object({
			value: Type.Number(),
			next: Type.Union([Type.Ref('Node'), Type.Null()]),
		}),
	},
	'Node',
);

const mixed = defineTable({
	fields: {
		// Raw native schemas, with no hint.
		meta: Type.Object({
			author: Type.String(),
			words: Type.Optional(Type.Integer()),
		}),
		size: Type.Enum(['small', 'large']),
		anything: Type.Any(),
		open: jsonValue,
		pair: Type.Tuple([Type.String(), Type.Number()]),
		maybe: Type.Union([Type.Number(), Type.Null()]),
		chain: Node,
		// Helpers, and native composition over them.
		title: field.string(),
		due: field.nullable(field.instant()),
		owner: field.string<NoteId>(),
		status: field.nullable(Type.Enum(['draft', 'published'])),
	},
});

type Row = RowOf<typeof mixed>;

export type _RowKeys = Expect<
	Equal<
		keyof Row,
		| 'id'
		| 'meta'
		| 'size'
		| 'anything'
		| 'open'
		| 'pair'
		| 'maybe'
		| 'chain'
		| 'title'
		| 'due'
		| 'owner'
		| 'status'
	>
>;
export type _RawObject = Expect<
	Equal<Row['meta'], { words?: number; author: string }>
>;
export type _RawEnum = Expect<Equal<Row['size'], 'small' | 'large'>>;
// biome-ignore lint/suspicious/noExplicitAny: the type under test is `any`
export type _RawAny = Expect<Equal<Row['anything'], any>>;
export type _RawJsonValue = Expect<Equal<Row['open'], JsonValue>>;
export type _RawTuple = Expect<Equal<Row['pair'], [string, number]>>;
export type _RawUnion = Expect<Equal<Row['maybe'], number | null>>;
export type _RawCyclic = Expect<Equal<Row['chain'], Static<typeof Node>>>;
export type _Helper = Expect<Equal<Row['title'], string>>;
export type _NullableHelper = Expect<Equal<Row['due'], InstantString | null>>;
export type _BrandedHelper = Expect<Equal<Row['owner'], NoteId>>;
export type _NullableRaw = Expect<
	Equal<Row['status'], 'draft' | 'published' | null>
>;
export type _CreateHasNoId = Expect<
	Equal<keyof CreateRowOf<typeof mixed>, Exclude<keyof Row, 'id'>>
>;

// The settings table takes the same schemas, each optional, so every setting
// may be unset.
const settings = defineTable({
	fields: {
		theme: field.optional(Type.Enum(['light', 'dark'])),
		window: field.optional(
			Type.Object({ width: Type.Integer(), height: Type.Integer() }),
		),
		name: field.optional(field.string()),
	},
});
const definition = {
	tables: { mixed, settings },
} satisfies DataSchema;
type Settings = {
	theme?: 'light' | 'dark';
	window?: { width: number; height: number };
	name?: string;
};
export type _SettingsRaw = Expect<
	Equal<CreateRowOf<typeof definition.tables.settings>, Settings>
>;

// field.optional makes a row field `name?:`, in a row and in its create values,
// and composes outside field.nullable.
const optionalFields = defineTable({
	fields: {
		title: field.string(),
		note: field.optional(field.string()),
		due: field.optional(field.nullable(field.instant())),
		raw: Type.Optional(Type.Integer()),
	},
});
export type _OptionalRow = Expect<
	Equal<
		RowOf<typeof optionalFields>,
		{ id: string } & {
			title: string;
			note?: string;
			due?: InstantString | null;
			raw?: number;
		}
	>
>;
export type _OptionalCreate = Expect<
	Equal<
		CreateRowOf<typeof optionalFields>,
		{
			title: string;
			note?: string;
			due?: InstantString | null;
			raw?: number;
		}
	>
>;
export const _withoutOptional: CreateRowOf<typeof optionalFields> = {
	title: 't',
};
// @ts-expect-error title is required; only the optional fields may be left out
export const _withoutRequired: CreateRowOf<typeof optionalFields> = {
	note: 'n',
};
// Every schema above is a field, with or without a hint.
export const _fields: FieldMap = { ...mixed.fields, ...settings.fields };

// The rules that are about a declaration, not an editor, hold for raw schemas.
defineTable({
	fields: {
		// @ts-expect-error 'id' is reserved: every row already has one
		id: Type.String(),
	},
});

// A refinement, codec, or guard holds a callback no file can, so preparation
// refuses one; its type is refused where it is declared, at the field.
const nonEmpty = (value: string) => value.length > 0;
defineTable({
	fields: {
		// @ts-expect-error a refinement is a callback, not JSON Schema
		title: Type.Refine(Type.String(), nonEmpty),
		// @ts-expect-error over a helper as well
		note: Type.Refine(field.string(), nonEmpty),
		// @ts-expect-error a codec is a callback too
		when: Type.Decode(Type.String(), (value) => new Date(value)),
	},
});

// A schema is an object. TypeBox's `TSchema` is an empty interface, so a
// primitive would satisfy it; a field map and the schema-taking helpers do not
// take one.
defineTable({
	fields: {
		// @ts-expect-error a string is not a schema
		title: 'string',
		// @ts-expect-error a number is not a schema
		count: 7,
		// @ts-expect-error a boolean is not a schema
		done: true,
	},
});
// @ts-expect-error a string is not a schema
export const _primitiveField: FieldMap = { title: 'string' };
// @ts-expect-error a string is not a schema
field.nullable('string');
// @ts-expect-error a number is not a schema
field.json(7);

// Schema objects of every native spelling are still taken, and a native
// `default` annotation is one of them.
const admitted = defineTable({
	fields: {
		literal: { type: 'string' },
		empty: {},
		withDefault: Type.String({ default: 'untitled' }),
		spreadDefault: { ...field.string(), default: 'untitled' },
		frozen: Object.freeze(field.select(['a', 'b'])),
		wrapped: field.json({ type: 'string' }),
		optional: field.nullable({ type: 'string' }),
	},
});
type Admitted = RowOf<typeof admitted>;
export type _DefaultStatic = Expect<Equal<Admitted['withDefault'], string>>;
export type _SpreadDefaultStatic = Expect<
	Equal<Admitted['spreadDefault'], string>
>;
export type _FrozenStatic = Expect<Equal<Admitted['frozen'], 'a' | 'b'>>;
// A default annotation does not make a field optional.
// @ts-expect-error withDefault is still required
export const _stillRequired: Pick<
	CreateRowOf<typeof admitted>,
	'withDefault'
> = {};

// A prepared schema has the declared type: the same literal keys and the
// same native schemas, so the lenses read it like the declaration.
const prepared = prepareSchema(definition).data;
if (prepared !== null) {
	prepared satisfies typeof definition;
	// A prepared native snapshot can be composed again without a cast.
	field.json(prepared.tables.settings.fields.name);
	field.nullable(prepared.tables.mixed.fields.title);
	// @ts-expect-error the prepared schema declares no such table
	prepared.tables.absent;
	// @ts-expect-error a prepared table has fields, and no name
	prepared.tables.mixed.name;
}
export type _PreparedSettings = Expect<
	Equal<
		CreateRowOf<NonNullable<typeof prepared>['tables']['settings']>,
		Settings
	>
>;
export type _PreparedRow = Expect<
	Equal<RowOf<NonNullable<typeof prepared>['tables']['mixed']>, Row>
>;
