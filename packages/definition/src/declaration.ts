/**
 * What an application declares, and what that declaration reads as.
 *
 * All vocabulary and no behaviour. A schema declares each table's value
 * fields; the lens at the bottom turns that declaration into the types an
 * application writes.
 *
 * Every type here is a LOOKUP. None asks whether its argument is a
 * declaration, because the parameter says so, and none can answer `never` for
 * "I could not tell". A schema that arrived as JSON never comes through
 * here: it reaches `prepareSchema` from a trusted TypeScript module and is
 * checked in `prepare.ts`.
 */

import type { Static, TObject, TSchema } from 'typebox';

export { field } from './field/index.js';

export const KV_ROOT = 'kv';
export const RESERVED_TABLE_NAMES: readonly string[] = [KV_ROOT];

/**
 * The table whose rows are settings, one row per concern, such as
 * `settings/display.md` (ADR-0576). Every field it declares is
 * `field.optional`: a setting may always be unset, and the application's
 * own default applies.
 */
export const SETTINGS_TABLE = 'settings';

/**
 * The fields of one bucket, by name.
 *
 * A field is any native TypeBox schema that is plain JSON. The `field.*`
 * helpers build common ones and annotate them with an editor; a bare
 * `Type.Object(...)`, `Type.Enum(...)`, or `Type.Any()` is a field too, and
 * gets the JSON editor. A refinement or codec is refused: it cannot be
 * written to a file.
 */
export type FieldMap = {
	// TypeBox's `TSchema` is an empty interface, which a string or a number
	// satisfies. A schema is an object.
	readonly [field: string]: TSchema & object;
};

/**
 * Value-field schemas, and whether the table is closed.
 *
 * `additionalProperties: false` is JSON Schema's own keyword for a closed
 * object: a stored row with a key `fields` does not declare does not conform.
 * Only a storage whose rows people write by hand keeps a closed table; one
 * that must read keys a newer release added refuses it.
 */
export type TableDeclaration = {
	readonly fields: FieldMap;
	readonly additionalProperties?: false;
};

/**
 * The mark `defineTable` leaves, and the only way to get one.
 *
 * A table declaration is a plain object, so any literal of the right shape used
 * to satisfy a schema. That made two authoring paths for one thing:
 * `defineTable`, which checks its parameter, and a bare literal handed to
 * a storage's definer, which needed a second set of conditional types to re-check the
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

/**
 * How stored data reads, naming no dataset: the optional title, the KV fields,
 * and the tables.
 *
 * A declaration and the prepared schema `prepareSchema` returns for it have
 * this one shape. The prepared one is an owned, frozen snapshot whose fields
 * `check` reads; a field of a declaration that was never prepared is refused
 * by it. A storage selects its dataset when it opens, so `prepareSchema`
 * refuses an `id`.
 */
export type DataSchema = {
	readonly title?: string;
	/**
	 * Files that stay on the machine that wrote them, as `.gitignore` patterns
	 * such as `audio/`. A storage that syncs commits none of them. Each is one
	 * line that ignores something: not empty, not a comment or a negation, and
	 * without surrounding whitespace.
	 */
	readonly local?: readonly string[];
	readonly kv: FieldMap;
	readonly tables: {
		readonly [table: string]: DeclaredTable;
	};
};

/** A field diagnostic. Messages and diagnostic counts are not machine contracts. */
export type ConformanceIssue = {
	field: string;
	/** JSON pointer within the field value, when the validator identifies it. */
	path?: string;
	message: string;
};

/**
 * What one bucket's fields read as: the bucket as one `Type.Object`, so a
 * `field.optional` field is `name?:`.
 */
type FieldsOut<TFields extends FieldMap> = Static<
	TObject<{ -readonly [K in keyof TFields]: TFields[K] }>
>;

/** A value snapshot. A storage with live bodies reaches them through its own handle. */
export type RowOf<T extends TableDeclaration> = { id: string } & FieldsOut<
	T['fields']
>;

/** Values supplied when creating a row. */
export type CreateRowOf<T extends TableDeclaration> = FieldsOut<T['fields']>;

/** Settings as read: every KV field may be unset. */
export type KvOf<TDatabase extends DataSchema> = Partial<
	FieldsOut<TDatabase['kv']>
>;
