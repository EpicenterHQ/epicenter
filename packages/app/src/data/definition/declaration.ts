/**
 * What an application declares, and what that declaration reads as.
 *
 * All vocabulary and no behaviour. A definition separates each table's value fields
 * from its optional body codec; the lens at the
 * bottom turns that declaration into the types an application writes.
 *
 * Every type here is a LOOKUP. None asks whether its argument is a
 * declaration, because the parameter says so, and none can answer `never` for
 * "I could not tell". A definition that arrived as JSON never comes through
 * here: it reaches `compileData` from a trusted TypeScript module and is
 * checked in `compile.ts`.
 */

import type * as Y from '@y/y';
import type { DeltaAny } from 'lib0/delta';
import { type Static, type TSchema, Type } from 'typebox';
import { type Field, field as genericField } from '../field/index.js';

export const KV_ROOT = 'kv';
export const RESERVED_TABLE_NAMES: readonly string[] = [KV_ROOT];

/**
 * The fields of one bucket, by name.
 *
 * A field IS a schema. It was `object` for one release, so that this one type
 * could describe both a declaration written with `field.*` and one that arrived
 * as JSON, and every type reading a declaration paid for it: unable to assume a
 * schema, each asked `extends TSchema` and answered `never` when the guess
 * failed. A wrong answer, silently, rather than an error.
 *
 * Nothing needed it. A definition is imported from a first-party TypeScript
 * module, so the serialized shape never needs a static form to accommodate.
 * What is declared here is what an author writes.
 */
export type FieldMap = {
	readonly [field: string]: TSchema;
};

/**
 * One table's file format for its body's complete sequence.
 *
 * The codec turns the live body into file text and parses file text into
 * insertion-only content. The artifact layer owns fresh-node creation and
 * in-place sequence replacement, preserving editor bindings and root attributes.
 * Nested rich-text nodes may carry their own attributes. A table without a
 * codec can export only an empty body and import only empty body text.
 */
export type BodyCodec = {
	readonly encode: (node: Y.Node) => string;
	readonly decode: (text: string) => DeltaAny;
};

/** Value-field schemas and the optional codec for the row's separately edited body. */
export type TableDeclaration = {
	readonly fields: FieldMap;
	readonly body?: BodyCodec;
};

/**
 * The mark `defineTable` leaves, and the only way to get one.
 *
 * A table declaration is a plain object, so any literal of the right shape used
 * to satisfy `DataDefinition`. That made two authoring paths for one thing:
 * `defineTable`, which checks its parameter, and a bare literal handed to
 * `defineStore`, which needed a second set of conditional types to re-check the
 * same rules and could not report them as well. Every rule was written twice
 * and one of the copies silently stopped applying for a day.
 *
 * Nominal, so there is one door. Nothing constructs this value: the brand is
 * declared and never assigned, and `defineTable`'s return asserts it.
 */
declare const DECLARED: unique symbol;

/**
 * The mark alone, without the shape.
 *
 * `defineTable` returns this intersected with the literal types it inferred,
 * never with `TableDeclaration`, so the row lens sees the exact field keys.
 */
export type DeclaredMark = { readonly [DECLARED]: true };

/** A table declaration that went through `defineTable`. */
export type DeclaredTable = TableDeclaration & DeclaredMark;

/** One durable data domain's complete, inert definition. */
export type DataDefinition = {
	readonly id: string;
	readonly title?: string;
	readonly kv: FieldMap;
	readonly tables: {
		readonly [table: string]: DeclaredTable;
	};
};

/**
 * Add data-substrate nullability without teaching the generic field package
 * about it.
 *
 * `Type.Union` with `Type.Null`, which is TypeBox's own spelling of exactly
 * this. It emits the same `anyOf: [inner, { type: 'null' }]` the hand-rolled
 * version did, byte for byte, and infers `Static<S> | null` including for a
 * BRANDED inner schema, which is the case that made this a function in the
 * first place.
 *
 * It used to be built with `Type.Unsafe` and two casts, because a schema
 * assembled that way leaves its `Static` to be recovered structurally from the
 * `anyOf` and that recovery produced `unknown` for a branded `TUnsafe`:
 * `field.nullable(field.string())` read as `string | null` while
 * `field.nullable(field.instant())` read as `unknown`, in the same table. That
 * is a real defect in structural recovery and it is not a reason to reach for
 * the escape hatch, because `Type.Union` never had it.
 *
 * TypeBox retains the tuple for the owning-field input lens; runtime compilation
 * recognizes the same nullable shape from its serialized schema.
 */
function nullable<S extends TSchema>(inner: S) {
	return Type.Union([inner, Type.Null()]);
}

/** The data definition's field namespace. */
export const field = Object.freeze({
	...genericField,
	nullable,
});

export type DataField = {
	readonly name: string;
	readonly kind: Field['kind'];
	readonly schema: unknown;
	readonly check: (value: unknown) => boolean;
	readonly nullable: boolean;
	readonly reference: string | null;
};

/** What one bucket's fields read as, once the schemas are resolved. */
type FieldsOut<TFields extends FieldMap> = {
	[K in keyof TFields]: Static<TFields[K]>;
};

/** A value snapshot. Live collaborative state is accessed through `table.body(id)`. */
export type RowOf<T extends TableDeclaration> = { id: string } & FieldsOut<
	T['fields']
>;

/** Values supplied when creating a row. The store creates its body in the same transaction. */
export type CreateRowOf<T extends TableDeclaration> = FieldsOut<T['fields']>;

export type KvOf<TDatabase extends DataDefinition> = FieldsOut<TDatabase['kv']>;
