/** Table declarations keep field schemas separate from the body conversion. */
import type {
	DeclaredMark,
	FieldMap,
	TableBody,
	TableDeclaration,
} from './declaration.js';

/**
 * A schema whose type says it holds a callback: a refinement, codec, or
 * guard. Preparation refuses one at run time because a file cannot hold it
 * (ADR-0525). Only the field's own type is read; one nested inside an object
 * or union is refused by preparation alone.
 */
type CallbackSchema =
	| { readonly '~refine': unknown }
	| { readonly '~codec': unknown }
	| { readonly '~guard': unknown };

/**
 * Field validation shared with KV: identity remains reserved, and a field is
 * a schema JSON can hold.
 */
export type ValidateFields<T extends FieldMap> = {
	[K in keyof T]: K extends string
		? Lowercase<K> extends 'id'
			? `'${K}' is reserved for row identity`
			: T[K] extends CallbackSchema
				? `'${K}' holds a callback, which JSON Schema cannot; check it after reading`
				: T[K]
		: T[K];
};

/**
 * The one authoring door for a table, typed for a storage's body conversion.
 * A storage binds `TBody` to what it keeps; the implementation is shared.
 */
export type DefineTable<TBody extends TableBody> = <
	const TTable extends TableDeclaration<TBody>,
>(
	table: TTable & {
		fields: ValidateFields<TTable['fields']>;
	} & Record<Exclude<keyof TTable, keyof TableDeclaration>, never>,
) => DeclaredMark & TTable;

/** Declare value fields and, optionally, how the row's body becomes file text. */
export const defineTable: DefineTable<TableBody> = (table) => table as never;
