/** The one authoring door for a table declaration. */
import type {
	DeclaredMark,
	FieldMap,
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
 * Field validation: identity remains reserved, and a field is a schema JSON
 * can hold.
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

/** The one authoring door for a table. */
export type DefineTable = <const TTable extends TableDeclaration>(
	table: TTable & {
		fields: ValidateFields<TTable['fields']>;
	} & Record<Exclude<keyof TTable, keyof TableDeclaration>, never>,
) => DeclaredMark & TTable;

/** Declare a table's value fields, and optionally close it. */
export const defineTable: DefineTable = (table) => table as never;
