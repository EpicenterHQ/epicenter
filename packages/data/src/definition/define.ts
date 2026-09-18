/**
 * The two authoring calls, and the refusals that shape their parameters.
 *
 * A declaration is checked twice: here, while it is being written, and again
 * in `compile.ts` when it is parsed. The runtime half is the one that catches a
 * definition this file never saw, which is the only reason both exist.
 *
 * ONE DOOR. `defineTable` brands its return and `DataDefinition` requires the
 * brand, so every table is checked here and nowhere else. There used to be a
 * second path: a bare literal handed to `defineData`, re-checked by
 * `ValidateTable` and `ValidateDefinition`, which restated the same rules
 * through a different mechanism and could not report them as well. Both are
 * deleted. What is left validates `kv`, which is the one field map an
 * application still writes inline.
 *
 * A table's value fields are top-level keys. The reserved `content` key is the
 * only non-field key, and `id` cannot be claimed by a value.
 */

import type { TSchema } from 'typebox';
import { compileData } from './compile.js';
import type {
	CONTENT_FIELD,
	ContentCodec,
	DeclaredMark,
	DeclaredTable,
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
 * `defineData` applies it to `kv`, which are the two places field maps are
 * authored.
 *
 * The reserved-name arm is what replaced a mapped type over the type-field
 * TUPLE that carried its error sentence in the element position. A row has one
 * node, at one reserved key, so a collision is a key comparison rather than a
 * search, and the message lands on the offending field.
 */
type ValidateFields<T extends FieldMap> = {
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

export function defineData<
	const TData extends {
		readonly id: string;
		readonly title?: string;
		readonly kv: FieldMap;
		readonly tables: { readonly [table: string]: unknown };
	},
>(
	data: TData & {
		kv: ValidateFields<TData['kv']>;
		// Per table, so the refusal lands on the table that is missing the
		// brand. A plain `{ [table: string]: DeclaredTable }` refuses the same
		// bare literal, but the error reports the whole `tables` object rather
		// than the one element, which is the difference between naming the
		// mistake and pointing at the neighbourhood. Same reason `ValidateFields`
		// maps over its keys.
		tables: {
			[N in keyof TData['tables']]: TData['tables'][N] extends DeclaredTable
				? TData['tables'][N]
				: DeclaredTable;
		};
	},
): TData {
	// Compile eagerly at the authoring call (ADR-0266): a malformed definition
	// fails here, as the programmer error it is, rather than at first open. The
	// compile is held beside this object, so an opener that later passes the same
	// definition is a cache hit and never recompiles.
	const compiled = compileData(data);
	if (compiled.error !== null) {
		throw new Error(compiled.error.message, { cause: compiled.error });
	}
	return data as TData;
}
