import { compile, recognize } from '@epicenter/field';
import {
	IsOptional,
	Optional,
	type Static,
	type TOptional,
	type TOptionalAdd,
	type TSchema,
} from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

import {
	DATA_ADDRESS_CEILINGS,
	isJsonValue,
	isNamespace,
	isTableName,
	isValueName,
	type JsonObject,
	type JsonValue,
	type RowAddress,
	type ValueAddress,
} from './protocol/index.js';
import { SCALAR_V1_LIMITS } from './protocol/v1/index.js';

type FieldSchemas = Record<string, TSchema>;

type OptionalFieldNames<TFields extends FieldSchemas> = {
	[K in keyof TFields]: TFields[K] extends TOptional ? K : never;
}[keyof TFields];

type RequiredFieldNames<TFields extends FieldSchemas> = Exclude<
	keyof TFields,
	OptionalFieldNames<TFields>
>;

export type FieldsFor<TFields extends FieldSchemas> = {
	[K in RequiredFieldNames<TFields>]: Static<TFields[K]>;
} & {
	[K in OptionalFieldNames<TFields>]?: Static<TFields[K]>;
};

declare const tableDefinitionParts: unique symbol;
declare const valueDefinitionParts: unique symbol;
declare const lensParts: unique symbol;

export type TableDefinition<TFields extends FieldSchemas = FieldSchemas> = {
	fields: TFields;
	[tableDefinitionParts]: { fields: TFields };
};

export type ValueDefinition<TValueSchema extends TSchema = TSchema> = {
	value: TValueSchema;
	[valueDefinitionParts]: TValueSchema;
};

export type TableDefinitions = Record<string, TableDefinition>;
export type ValueDefinitions = Record<string, ValueDefinition>;

/**
 * One application's complete interpretation of one durable namespace
 * (ADR-0160, ADR-0168).
 *
 * The namespace is declared exactly once, here. Each `tables` and `values`
 * property name is the durable local key for that table or value: `notes` in
 * `tables` addresses `{ kind: 'row', namespace, tableName: 'notes', rowId }`
 * forever. There is no second `key` field to keep in step with the property
 * name, and no rename operation: a different property name is a different
 * address, and therefore different data.
 *
 * Row and value names occupy disjoint key spaces, so one namespace may declare
 * both a `notes` table and a `notes` value.
 *
 * The two kinds have different grammars because they are consumed differently
 * (ADR-0162, ADR-0178). A table name must be a bare SQL identifier, since a
 * trusted host mounts it as a relation. A value name is never a relation or a
 * column, so it may carry opaque dotted grouping such as
 * `settings.sound.manualStart`; those dots are part of one durable name and
 * imply no nesting, prefix matching, or lifecycle of their own.
 */
export type Lens<
	TTables extends TableDefinitions = TableDefinitions,
	TValues extends ValueDefinitions = ValueDefinitions,
> = {
	namespace: string;
	tables: TTables;
	values: TValues;
	[lensParts]: { tables: TTables; values: TValues };
};

export type RowFor<TDefinition extends TableDefinition> =
	TDefinition extends TableDefinition<infer TFields>
		? { id: string } & FieldsFor<TFields>
		: never;

export type CreateInputFor<TDefinition extends TableDefinition> =
	TDefinition extends TableDefinition<infer TFields>
		? FieldsFor<TFields> & { id?: never }
		: never;

export type ConstrainedUpdate<
	TDefinition extends TableDefinition,
	TChanges extends Record<string, unknown>,
> =
	TDefinition extends TableDefinition<infer TFields>
		? Record<Exclude<keyof TChanges, keyof TFields>, never> & {
				[K in keyof TChanges]: K extends keyof TFields
					? K extends OptionalFieldNames<TFields>
						? Static<TFields[K]> | undefined
						: Static<TFields[K]>
					: never;
			}
		: never;

export type ValueFor<TDefinition extends ValueDefinition> =
	TDefinition extends ValueDefinition<infer TSchema> ? Static<TSchema> : never;

export type ConformanceIssue = {
	field: string;
	kind: 'missing' | 'invalid';
	message: string;
};

export const DataReadError = defineErrors({
	NonconformingRow: ({
		address,
		raw,
		issues,
	}: {
		address: RowAddress;
		raw: JsonObject;
		issues: readonly ConformanceIssue[];
	}) => ({
		message: `Stored row '${address.namespace}/${address.tableName}/${address.rowId}' does not satisfy the current definition`,
		address,
		/** The structural row id, which is also `address.rowId`. */
		id: address.rowId,
		raw,
		issues,
	}),
	NonconformingValue: ({
		address,
		raw,
	}: {
		address: ValueAddress;
		raw: JsonValue;
	}) => ({
		message: `Stored value '${address.namespace}/${address.valueName}' does not satisfy the current definition`,
		address,
		raw,
	}),
});
export type DataReadError = InferErrors<typeof DataReadError>;
export type NonconformingRowError = Extract<
	DataReadError,
	{ name: 'NonconformingRow' }
>;
export type NonconformingValueError = Extract<
	DataReadError,
	{ name: 'NonconformingValue' }
>;

type CompiledField = {
	check(value: unknown): boolean;
};

export type NormalizedUpdate = {
	set: JsonObject;
	unset: string[];
};

export type CompiledTableDefinition = {
	fields: ReadonlyMap<string, CompiledField>;
	optional: ReadonlySet<string>;
	project(
		address: RowAddress,
		payload: JsonObject,
	): Result<Record<string, unknown>, NonconformingRowError>;
	validateCreate(input: Record<string, unknown>): JsonObject;
	normalizeUpdate(input: Record<string, unknown>): NormalizedUpdate;
};

export type CompiledValueDefinition = {
	project(
		address: ValueAddress,
		value: JsonValue,
	): Result<unknown, NonconformingValueError>;
	validate(value: unknown): JsonValue;
};

const compiledTables = new WeakMap<object, CompiledTableDefinition>();
const compiledValues = new WeakMap<object, CompiledValueDefinition>();

/** Mark one field as optional in a table definition. */
export function optional<TSchemaValue extends TSchema>(
	schema: TSchemaValue,
): TOptionalAdd<TSchemaValue> {
	return Optional(schema);
}

export function defineTable<const TFields extends FieldSchemas>({
	fields: fieldsInput,
}: {
	fields: TFields & { id?: never };
}): TableDefinition<TFields> {
	assertPlainObject(fieldsInput, 'Table fields');
	if (Object.keys(fieldsInput).some((name) => name.toLowerCase() === 'id')) {
		throw new Error(
			"Table definitions cannot declare the structural 'id' field",
		);
	}
	assertNoCaseInsensitiveDuplicates(Object.keys(fieldsInput), 'field');

	const fields: FieldSchemas = {};
	const compiledFields = new Map<string, CompiledField>();
	const optionalFields = new Set<string>();
	for (const [name, authoredSchema] of Object.entries(fieldsInput)) {
		assertFieldName(name);
		const schema = cloneSchema(authoredSchema);
		const recognized = recognize(schema);
		if (recognized === null) {
			throw new Error(`Field '${name}' must use the field.* vocabulary`);
		}
		fields[name] = freezeJson(schema);
		compiledFields.set(name, { check: compile(recognized.schema) });
		if (IsOptional(authoredSchema)) optionalFields.add(name);
	}

	const definition = Object.freeze({
		fields: Object.freeze(fields),
	}) as TableDefinition<TFields>;
	compiledTables.set(
		definition,
		createCompiledTable(compiledFields, optionalFields),
	);
	return definition;
}

export function defineValue<const TSchemaValue extends TSchema>({
	value: authoredSchema,
}: {
	value: TSchemaValue;
}): ValueDefinition<TSchemaValue> {
	if (IsOptional(authoredSchema)) {
		throw new Error('Singleton values cannot use optional(...)');
	}
	const schema = cloneSchema(authoredSchema);
	const recognized = recognize(schema);
	if (recognized === null) {
		throw new Error('Value must use the field.* vocabulary');
	}
	const check = compile(recognized.schema);
	const definition = Object.freeze({
		value: freezeJson(schema),
	}) as ValueDefinition<TSchemaValue>;
	compiledValues.set(definition, {
		project(address, value) {
			return check(value)
				? Ok(structuredClone(value))
				: DataReadError.NonconformingValue({
						address,
						raw: structuredClone(value),
					});
		},
		validate(value) {
			if (!check(value)) throw new TypeError('Invalid singleton value');
			return cloneJsonValue(value);
		},
	});
	return definition;
}

/**
 * Declare one application's interpretation of one durable namespace.
 *
 * Every table and value name must be usable as a SQL identifier, because a
 * trusted inspection host mounts a selected Lens as logical relations named
 * exactly after these properties (ADR-0162). SQL identifiers are
 * case-insensitive, so two names differing only in case are refused here rather
 * than colliding later at mount time.
 */
export function defineLens<
	const TTables extends TableDefinitions,
	const TValues extends ValueDefinitions,
>({
	namespace,
	tables,
	values,
}: {
	namespace: string;
	tables: TTables;
	values: TValues;
}): Lens<TTables, TValues> {
	if (!isNamespace(namespace, DATA_ADDRESS_CEILINGS)) {
		throw new Error(
			`Invalid namespace '${namespace}'; use two or more lowercase dot-separated labels`,
		);
	}
	assertPlainObject(tables, 'Lens tables');
	assertPlainObject(values, 'Lens values');
	for (const [name, definition] of Object.entries(tables)) {
		assertTableName(name);
		compileTableDefinition(definition);
	}
	for (const [name, definition] of Object.entries(values)) {
		assertValueName(name);
		compileValueDefinition(definition);
	}
	// Only table names are checked for case-insensitive collision, because only
	// they become SQL identifiers when a Lens is mounted. Value names are data in
	// the raw value projection, never a relation or a column, so two value names
	// differing only in case are simply two addresses (ADR-0162, ADR-0178).
	assertNoCaseInsensitiveDuplicates(Object.keys(tables), 'table');
	return Object.freeze({
		namespace,
		tables: Object.freeze(tables),
		values: Object.freeze(values),
	}) as Lens<TTables, TValues>;
}

export function compileTableDefinition(
	definition: TableDefinition,
): CompiledTableDefinition {
	const compiled = compiledTables.get(definition);
	if (compiled === undefined) throw new Error('Unknown table definition');
	return compiled;
}

export function compileValueDefinition(
	definition: ValueDefinition,
): CompiledValueDefinition {
	const compiled = compiledValues.get(definition);
	if (compiled === undefined) throw new Error('Unknown value definition');
	return compiled;
}

function createCompiledTable(
	fields: ReadonlyMap<string, CompiledField>,
	optionalFields: ReadonlySet<string>,
): CompiledTableDefinition {
	return {
		fields,
		optional: optionalFields,
		project(address, payload) {
			const projected: Record<string, unknown> = { id: address.rowId };
			const issues: ConformanceIssue[] = [];
			for (const [name, field] of fields) {
				if (!Object.hasOwn(payload, name)) {
					if (!optionalFields.has(name)) {
						issues.push({
							field: name,
							kind: 'missing',
							message: `Missing required field '${name}'`,
						});
					}
					continue;
				}
				const value = payload[name];
				if (!field.check(value)) {
					issues.push({
						field: name,
						kind: 'invalid',
						message: `Field '${name}' is invalid`,
					});
					continue;
				}
				projected[name] = structuredClone(value);
			}
			return issues.length === 0
				? Ok(projected)
				: DataReadError.NonconformingRow({
						address,
						raw: structuredClone(payload),
						issues,
					});
		},
		validateCreate(input) {
			assertPlainObject(input, 'Create input');
			const payload: JsonObject = {};
			for (const name of Object.keys(input)) {
				if (!fields.has(name)) throw new Error(`Unknown field '${name}'`);
			}
			for (const [name, field] of fields) {
				if (!Object.hasOwn(input, name) || input[name] === undefined) {
					if (!optionalFields.has(name)) {
						throw new Error(`Missing required field '${name}'`);
					}
					continue;
				}
				const value = input[name];
				if (!field.check(value)) throw new TypeError(`Invalid field '${name}'`);
				payload[name] = cloneJsonValue(value);
			}
			return payload;
		},
		normalizeUpdate(input) {
			assertPlainObject(input, 'Update input');
			const set: JsonObject = {};
			const unset: string[] = [];
			for (const [name, value] of Object.entries(input)) {
				const field = fields.get(name);
				if (field === undefined) throw new Error(`Unknown field '${name}'`);
				if (value === undefined) {
					if (!optionalFields.has(name)) {
						throw new TypeError(`Required field '${name}' cannot be unset`);
					}
					unset.push(name);
					continue;
				}
				if (!field.check(value)) throw new TypeError(`Invalid field '${name}'`);
				set[name] = cloneJsonValue(value);
			}
			return { set, unset };
		},
	};
}

function assertTableName(name: string): void {
	if (!isTableName(name, DATA_ADDRESS_CEILINGS)) {
		throw new Error(
			`Invalid table name '${name}'; start with a letter and use letters, digits, and underscores, because a table name is mounted as a SQL relation`,
		);
	}
}

function assertValueName(name: string): void {
	if (!isValueName(name, DATA_ADDRESS_CEILINGS)) {
		throw new Error(
			`Invalid value name '${name}'; use dot-separated segments that each start with a letter, such as 'settings.sound.manualStart'`,
		);
	}
}

function assertNoCaseInsensitiveDuplicates(
	names: readonly string[],
	label: 'table' | 'field',
): void {
	const seen = new Map<string, string>();
	for (const name of names) {
		const folded = name.toLowerCase();
		const existing = seen.get(folded);
		if (existing !== undefined) {
			throw new Error(
				`Ambiguous ${label} names '${existing}' and '${name}' differ only by case`,
			);
		}
		seen.set(folded, name);
	}
}

function assertFieldName(name: string): void {
	if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
		throw new Error(
			`Invalid field name '${name}'; use letters, digits, and underscores`,
		);
	}
}

function assertPlainObject(
	value: unknown,
	label: string,
): asserts value is Record<string, unknown> {
	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null)
	) {
		throw new TypeError(`${label} must be a plain object`);
	}
}

function cloneSchema<TSchemaValue extends TSchema>(
	schema: TSchemaValue,
): TSchemaValue {
	return JSON.parse(JSON.stringify(schema)) as TSchemaValue;
}

function freezeJson<TValue>(value: TValue): TValue {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
		return value;
	}
	for (const child of Object.values(value)) freezeJson(child);
	return Object.freeze(value);
}

function cloneJsonValue(value: unknown): JsonValue {
	// Checked against the shipped wire ceilings rather than a shape-only guard:
	// a Lens value that cannot be encoded as a fact is worth refusing where it is
	// authored, not one round trip later when the authority declines it.
	if (!isJsonValue(value, SCALAR_V1_LIMITS)) {
		throw new TypeError('Value must be finite JSON');
	}
	return structuredClone(value);
}
