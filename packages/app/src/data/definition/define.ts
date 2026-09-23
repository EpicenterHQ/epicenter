/**
 * Table authoring and the field constraints shared with defineStore.
 *
 * defineTable brands its result so the application constructor can require
 * validated tables. compileData checks the runtime schema at declaration time.
 */

import type { TSchema } from 'typebox';
import type {
	CONTENT_FIELD,
	ContentCodec,
	DeclaredMark,
	FieldMap,
} from './declaration.js';

type RejectDefault<T> = T extends { default: unknown } ? never : T;

type ReservedRowKey<K extends string> =
	Lowercase<K> extends 'id'
		? `'${K}' is reserved: every row already has an id and a content node`
		: never;

/**
 * The value fields of one table, with a declared default refused at the field and
 * a reserved name refused at the key.
 *
 * `defineTable` applies this to all top-level table keys except `content`, and
 * `defineStore` applies it to `kv`, which are the two places field maps are
 * authored.
 *
 * The reserved-name arm is what replaced a mapped type over the type-field
 * TUPLE that carried its error sentence in the element position. A row has one
 * node, at one reserved key, so a collision is a key comparison rather than a
 * search, and the message lands on the offending field.
 */
export type ValidateFields<T extends FieldMap> = {
	[K in keyof T]: K extends string
		? ReservedRowKey<K> extends never
			? RejectDefault<T[K]>
			: ReservedRowKey<K>
		: RejectDefault<T[K]>;
};

type ValidateTable<T extends Record<string, unknown>> = {
	[K in keyof T]: K extends typeof CONTENT_FIELD
		? T[K] extends ContentCodec
			? T[K]
			: ContentCodec
		: T[K] extends TSchema
			? K extends string
				? ReservedRowKey<K> extends never
					? RejectDefault<T[K]>
					: ReservedRowKey<K>
				: RejectDefault<T[K]>
			: never;
};

/**
 * Declare one table.
 *
 * Content is optional and has no default codec. Omit it for fields-only
 * artifacts; populated nodes then refuse export and incoming body text refuses
 * import. Every row still owns a live content node.
 *
 * A supplied codec must implement all three verbs. The return preserves the
 * exact declaration and adds only its authoring brand.
 */
export function defineTable<const TTable extends Record<string, unknown>>(
	table: TTable & ValidateTable<TTable>,
): DeclaredMark & TTable {
	// The brand is a phantom: declared, never assigned, and asserted here.
	return table as unknown as DeclaredMark & TTable;
}
