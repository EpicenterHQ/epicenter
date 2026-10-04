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
	isJsonValue,
	type JsonObject,
	type JsonValue,
	parseMemberKey,
	parseNamespaceKey,
} from './protocol/index.js';

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

export type TableDefinition<TFields extends FieldSchemas = FieldSchemas> = {
	namespace: string;
	table: string;
	fields: TFields;
	[tableDefinitionParts]: { fields: TFields };
};

export type ValueDefinition<TValueSchema extends TSchema = TSchema> = {
	namespace: string;
	value: string;
	schema: TValueSchema;
	[valueDefinitionParts]: TValueSchema;
};

export type TableDefinitions = Record<string, TableDefinition>;
export type ValueDefinitions = Record<string, ValueDefinition>;

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
		namespace,
		table,
		id,
		raw,
		issues,
	}: {
		namespace: string;
		table: string;
		id: string;
		raw: JsonObject;
		issues: readonly ConformanceIssue[];
	}) => ({
		message: `Stored row '${namespace}/${table}/${id}' does not satisfy the current definition`,
		namespace,
		table,
		id,
		raw,
		issues,
	}),
	NonconformingValue: ({
		namespace,
		value,
		raw,
	}: {
		namespace: string;
		value: string;
		raw: JsonValue;
	}) => ({
		message: `Stored value '${namespace}/${value}' does not satisfy the current definition`,
		namespace,
		value,
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
		id: string,
		payload: JsonObject,
	): Result<Record<string, unknown>, NonconformingRowError>;
	validateCreate(input: Record<string, unknown>): JsonObject;
	normalizeUpdate(input: Record<string, unknown>): NormalizedUpdate;
};

export type CompiledValueDefinition = {
	project(value: JsonValue): Result<unknown, NonconformingValueError>;
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
	namespace,
	table,
	fields: fieldsInput,
}: {
	namespace: string;
	table: string;
	fields: TFields & { id?: never };
}): TableDefinition<TFields> {
	assertNamespaceKey(namespace);
	assertMemberKey(table, 'table');
	assertPlainObject(fieldsInput, 'Table fields');
	if (Object.keys(fieldsInput).some((name) => name.toLowerCase() === 'id')) {
		throw new Error(
			"Table definitions cannot declare the structural 'id' field",
		);
	}

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
		namespace,
		table,
		fields: Object.freeze(fields),
	}) as TableDefinition<TFields>;
	compiledTables.set(
		definition,
		createCompiledTable({ namespace, table }, compiledFields, optionalFields),
	);
	return definition;
}

export function defineValue<const TSchemaValue extends TSchema>({
	namespace,
	value,
	schema: authoredSchema,
}: {
	namespace: string;
	value: string;
	schema: TSchemaValue;
}): ValueDefinition<TSchemaValue> {
	assertNamespaceKey(namespace);
	assertMemberKey(value, 'value');
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
		namespace,
		value,
		schema: freezeJson(schema),
	}) as ValueDefinition<TSchemaValue>;
	compiledValues.set(definition, {
		project(stored) {
			return check(stored)
				? Ok(structuredClone(stored))
				: DataReadError.NonconformingValue({
						namespace,
						value,
						raw: structuredClone(stored),
					});
		},
		validate(candidate) {
			if (!check(candidate)) {
				throw new TypeError(`Invalid value for '${namespace}/${value}'`);
			}
			return cloneJsonValue(candidate);
		},
	});
	return definition;
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
	address: { namespace: string; table: string },
	fields: ReadonlyMap<string, CompiledField>,
	optionalFields: ReadonlySet<string>,
): CompiledTableDefinition {
	return {
		fields,
		optional: optionalFields,
		project(id, payload) {
			const projected: Record<string, unknown> = { id };
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
						namespace: address.namespace,
						table: address.table,
						id,
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

function assertNamespaceKey(namespace: string): void {
	if (parseNamespaceKey(namespace).error !== null) {
		throw new Error(`Invalid namespace key '${namespace}'`);
	}
}

function assertMemberKey(member: string, label: string): void {
	if (parseMemberKey(member).error !== null) {
		throw new Error(`Invalid ${label} key '${member}'`);
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
	if (!isJsonValue(value)) throw new TypeError('Value must be finite JSON');
	return structuredClone(value);
}
