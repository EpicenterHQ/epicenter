/** Table declarations keep field schemas separate from the body codec. */
import type {
	DeclaredMark,
	FieldMap,
	TableDeclaration,
} from './declaration.js';

type RejectDefault<T> = T extends { default: unknown } ? never : T;

/** Field validation shared with KV; identity remains reserved. */
export type ValidateFields<T extends FieldMap> = {
	[K in keyof T]: K extends string
		? Lowercase<K> extends 'id'
			? `'${K}' is reserved for row identity`
			: RejectDefault<T[K]>
		: RejectDefault<T[K]>;
};

/** Declare value fields and, optionally, how the row's body becomes file text. */
export function defineTable<const TTable extends TableDeclaration>(
	table: TTable & {
		fields: ValidateFields<TTable['fields']>;
	} & Record<Exclude<keyof TTable, keyof TableDeclaration>, never>,
): DeclaredMark & TTable {
	return table as unknown as DeclaredMark & TTable;
}
