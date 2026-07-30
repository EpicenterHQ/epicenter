/**
 * @fileoverview Rebinding a Lens that arrived over a carrier as JSON.
 *
 * Both RPC owners face the same problem. A surface holds the typed Lens; the
 * owner holds the replica. What crosses between them is the serialized
 * definition, so the owner has to turn that JSON back into a real Lens, bind it,
 * and hand the resulting handle to a switch that knows nothing about the
 * surface's types.
 *
 * That is one job with two callers, the browser worker and the desktop owner,
 * and it was written twice. The copies had already drifted in formatting, and
 * the next divergence would have been the kind that matters: two answers to how
 * a serialized optional field is reconstructed, or which property name a
 * proxied table binds under, with no test able to see the disagreement because
 * each owner only ever exercises its own copy.
 *
 * The handles are deliberately untyped here. The definition arrived as JSON, so
 * there is no type parameter left to recover; the surface that authored the
 * Lens is the one that still knows the row shape, and it is the one that reads
 * the answer back.
 */

import {
	defineLens,
	defineTable,
	defineValue,
	optional,
	type SerializedTableDefinition,
	type SerializedValueDefinition,
	type TableDefinition,
	type ValueDefinition,
} from '@epicenter/lens';
import type { TSchema } from 'typebox';

import type { RowDocument } from './documents.js';
import {
	type Epicenter,
	type InternalTableLens,
	readTableEntriesPage,
} from './epicenter.js';

/** One proxied table handle, with the row type erased by the carrier. */
export type UntypedTableLens = {
	create(fields: Record<string, unknown>): Promise<unknown>;
	get(rowId: string): Promise<unknown>;
	update(rowId: string, patch: Record<string, unknown>): Promise<unknown>;
	delete(rowId: string): Promise<boolean>;
	[readTableEntriesPage](after?: string): Promise<unknown>;
	openDocument(rowId: string): Promise<RowDocument>;
};

/** One proxied value handle, with the value type erased by the carrier. */
export type UntypedValueLens = {
	get(): Promise<unknown>;
	set(value: unknown): Promise<void>;
	unset(): Promise<void>;
};

/** Bind one serialized table definition and answer its untyped handle. */
export function tableLens(
	epicenter: Epicenter,
	definition: SerializedTableDefinition,
): UntypedTableLens {
	// The serialized table name is the durable local key, so the reconstructed
	// Lens must declare it under that exact property name. Binding under a fixed
	// placeholder would address every proxied table identically.
	return epicenter.bind(
		defineLens({
			namespace: definition.namespace,
			tables: { [definition.table]: deserializeTable(definition) },
			values: {},
		}),
	).tables[definition.table] as InternalTableLens<TableDefinition>;
}

/** Bind one serialized value definition and answer its untyped handle. */
export function valueLens(
	epicenter: Epicenter,
	definition: SerializedValueDefinition,
): UntypedValueLens {
	const valueDefinition = defineValue({
		value: definition.value as TSchema,
	}) as ValueDefinition;
	return epicenter.bind(
		defineLens({
			namespace: definition.address.namespace,
			tables: {},
			values: { [definition.address.valueName]: valueDefinition },
		}),
	).values[definition.address.valueName] as UntypedValueLens;
}

/**
 * Rebuild one table definition from its serialized form.
 *
 * `optionalFields` is carried beside the schemas because TypeBox's optional
 * marker does not survive the JSON round trip, so optionality has to be
 * reapplied here rather than read back off the schema.
 */
function deserializeTable(
	definition: SerializedTableDefinition,
): TableDefinition {
	const fields: Record<string, TSchema> = {};
	const optionalFields = new Set(definition.optionalFields);
	for (const [name, schema] of Object.entries(definition.fields)) {
		const typedSchema = schema as TSchema;
		fields[name] = optionalFields.has(name)
			? optional(typedSchema)
			: typedSchema;
	}
	return defineTable({ fields });
}
