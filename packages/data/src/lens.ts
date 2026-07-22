import { compile, recognize } from '@epicenter/field';
import type { Static, TSchema } from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

import {
	deepFreeze,
	isCanonicalJson,
	isJsonValue,
	isLocalKey,
	isNamespaceKey,
	isWellFormedString,
	type JsonObject,
	type JsonValue,
	SCALAR_SYNC_V1_LIMITS,
} from './protocol/v1/index.js';

const MAX_LENS_JSON_NODES = 100_000;

type FieldSchemas = Record<string, TSchema>;

export type TableDefinition<
	TFields extends FieldSchemas = FieldSchemas,
	TOptional extends readonly (keyof TFields &
		string)[] = readonly (keyof TFields & string)[],
> = {
	kind: 'table';
	title: string;
	description?: string;
	fields: TFields;
	optional: TOptional;
};

export type ValuesDefinition<TValues extends FieldSchemas = FieldSchemas> = {
	kind: 'values';
	title: string;
	description?: string;
	values: TValues;
};

export type CollectionDefinition = TableDefinition | ValuesDefinition;
export type CollectionDefinitions = Record<string, CollectionDefinition>;

export type LensDefinition<
	TCollections extends CollectionDefinitions = CollectionDefinitions,
> = {
	namespace: string;
	title: string;
	description: string;
	collections: TCollections;
};

type OptionalFieldNames<TDefinition extends TableDefinition> =
	TDefinition extends TableDefinition<infer _TFields, infer TOptional>
		? TOptional[number]
		: never;

type RequiredFieldNames<TDefinition extends TableDefinition> = Exclude<
	keyof TDefinition['fields'],
	OptionalFieldNames<TDefinition>
>;

export type FieldsFor<TDefinition extends TableDefinition> = {
	[K in RequiredFieldNames<TDefinition>]: Static<TDefinition['fields'][K]>;
} & {
	[K in OptionalFieldNames<TDefinition>]?: Static<TDefinition['fields'][K]>;
};

export type RowFor<TDefinition extends TableDefinition> = {
	id: string;
} & FieldsFor<TDefinition>;

export type CreateInputFor<TDefinition extends TableDefinition> =
	FieldsFor<TDefinition> & { id?: never };

export type ConstrainedUpdate<
	TDefinition extends TableDefinition,
	TChanges extends Record<string, unknown>,
> = Record<Exclude<keyof TChanges, keyof TDefinition['fields']>, never> & {
	[K in keyof TChanges]: K extends keyof TDefinition['fields']
		? K extends OptionalFieldNames<TDefinition>
			? Static<TDefinition['fields'][K]> | undefined
			: Static<TDefinition['fields'][K]>
		: never;
};

export type ValueFor<TSchemaValue extends TSchema> = Static<TSchemaValue>;

export type ConformanceIssue = {
	field: string;
	kind: 'missing' | 'invalid';
	message: string;
};

export const LensReadError = defineErrors({
	NonconformingRow: ({
		namespace,
		collection,
		id,
		raw,
		issues,
	}: {
		namespace: string;
		collection: string;
		id: string;
		raw: JsonObject;
		issues: readonly ConformanceIssue[];
	}) => ({
		message: `Stored record '${namespace}/${collection}/${id}' does not satisfy the current Lens`,
		namespace,
		collection,
		id,
		raw,
		issues,
	}),
	NonconformingValue: ({
		namespace,
		collection,
		recordKey,
		raw,
	}: {
		namespace: string;
		collection: string;
		recordKey: string;
		raw: JsonValue;
	}) => ({
		message: `Stored record '${namespace}/${collection}/${recordKey}' does not satisfy the current Lens`,
		namespace,
		collection,
		recordKey,
		raw,
	}),
});
export type LensReadError = InferErrors<typeof LensReadError>;
export type NonconformingRowError = Extract<
	LensReadError,
	{ name: 'NonconformingRow' }
>;
export type NonconformingValueError = Extract<
	LensReadError,
	{ name: 'NonconformingValue' }
>;

export const LensParseError = defineErrors({
	InvalidLens: ({ reason }: { reason: string }) => ({
		message: `Invalid Lens: ${reason}`,
		reason,
	}),
});
export type LensParseError = InferErrors<typeof LensParseError>;

export type NormalizedUpdate = { set: JsonObject; unset: string[] };

export type CompiledTableDefinition = {
	project(
		id: string,
		payload: JsonObject,
	): Result<Record<string, unknown>, NonconformingRowError>;
	validateCreate(input: Record<string, unknown>): JsonObject;
	normalizeUpdate(input: Record<string, unknown>): NormalizedUpdate;
};

export type CompiledValueDefinition = {
	project(
		value: JsonValue,
		address: { namespace: string; collection: string; recordKey: string },
	): Result<unknown, NonconformingValueError>;
	validate(value: unknown): JsonValue;
};

export function defineTable<
	const TFields extends FieldSchemas,
	const TOptional extends readonly (keyof TFields & string)[],
>({
	title,
	description,
	fields,
	optional,
}: {
	title: string;
	description?: string;
	fields: TFields & { id?: never };
	optional: TOptional;
}): TableDefinition<TFields, TOptional> {
	return validateTable({
		kind: 'table',
		title,
		...(description === undefined ? {} : { description }),
		fields: cloneSchemas(fields),
		optional: [...optional],
	}) as TableDefinition<TFields, TOptional>;
}

export function defineValues<const TValues extends FieldSchemas>({
	title,
	description,
	values,
}: {
	title: string;
	description?: string;
	values: TValues;
}): ValuesDefinition<TValues> {
	return validateValues({
		kind: 'values',
		title,
		...(description === undefined ? {} : { description }),
		values: cloneSchemas(values),
	}) as ValuesDefinition<TValues>;
}

export function defineLens<const TCollections extends CollectionDefinitions>({
	namespace,
	title,
	description,
	collections,
}: LensDefinition<TCollections>): LensDefinition<TCollections> {
	const parsed = parseLens({ namespace, title, description, collections });
	if (parsed.error !== null) throw parsed.error;
	return parsed.data as LensDefinition<TCollections>;
}

export function parseLens(
	value: unknown,
): Result<LensDefinition, LensParseError> {
	try {
		if (!isCanonicalJson(value, MAX_LENS_JSON_NODES)) {
			return LensParseError.InvalidLens({ reason: 'expected pure JSON data' });
		}
		const candidate = structuredClone(value);
		assertExactKeys(candidate, [
			'namespace',
			'title',
			'description',
			'collections',
		]);
		if (!isNamespaceKey(candidate.namespace, SCALAR_SYNC_V1_LIMITS)) {
			throw new Error('namespace is invalid');
		}
		assertText(candidate.title, 'title');
		assertText(candidate.description, 'description');
		assertPlainObject(candidate.collections, 'collections');
		const collections: CollectionDefinitions = {};
		for (const [key, collection] of Object.entries(candidate.collections)) {
			if (!isLocalKey(key, SCALAR_SYNC_V1_LIMITS)) {
				throw new Error(`collection key '${key}' is invalid`);
			}
			assertPlainObject(collection, `collections.${key}`);
			collections[key] =
				collection.kind === 'table'
					? validateTable(collection)
					: collection.kind === 'values'
						? validateValues(collection)
						: (() => {
								throw new Error(`collections.${key}.kind is invalid`);
							})();
		}
		return Ok(
			deepFreeze({
				namespace: candidate.namespace,
				title: candidate.title,
				description: candidate.description,
				collections,
			}),
		);
	} catch (cause) {
		return LensParseError.InvalidLens({
			reason: cause instanceof Error ? cause.message : 'validation failed',
		});
	}
}

export function compileTableDefinition(
	definition: TableDefinition,
	address: { namespace: string; collection: string },
): CompiledTableDefinition {
	const fields = new Map(
		Object.entries(definition.fields).map(([key, schema]) => {
			const recognized = recognize(schema);
			if (recognized === null || recognized.kind === 'reference') {
				throw new Error(`Unsupported field '${key}'`);
			}
			return [key, compile(recognized.schema)] as const;
		}),
	);
	const optional = new Set(definition.optional);
	return {
		project(id, payload) {
			const projected: Record<string, unknown> = { id };
			const issues: ConformanceIssue[] = [];
			for (const [name, check] of fields) {
				if (!Object.hasOwn(payload, name)) {
					if (!optional.has(name)) {
						issues.push({
							field: name,
							kind: 'missing',
							message: `Missing required field '${name}'`,
						});
					}
					continue;
				}
				const value = payload[name];
				if (!check(value)) {
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
				: LensReadError.NonconformingRow({
						namespace: address.namespace,
						collection: address.collection,
						id,
						raw: structuredClone(payload),
						issues,
					});
		},
		validateCreate(input) {
			assertPlainObject(input, 'create input');
			const payload: JsonObject = {};
			for (const key of Object.keys(input)) {
				if (!fields.has(key)) throw new Error(`Unknown field '${key}'`);
			}
			for (const [name, check] of fields) {
				if (!Object.hasOwn(input, name) || input[name] === undefined) {
					if (!optional.has(name)) {
						throw new Error(`Missing required field '${name}'`);
					}
					continue;
				}
				const value = input[name];
				if (!check(value)) throw new TypeError(`Invalid field '${name}'`);
				payload[name] = cloneJsonValue(value);
			}
			return payload;
		},
		normalizeUpdate(input) {
			assertPlainObject(input, 'update input');
			const set: JsonObject = {};
			const unset: string[] = [];
			for (const [name, value] of Object.entries(input)) {
				const check = fields.get(name);
				if (check === undefined) throw new Error(`Unknown field '${name}'`);
				if (value === undefined) {
					if (!optional.has(name)) {
						throw new TypeError(`Required field '${name}' cannot be unset`);
					}
					unset.push(name);
					continue;
				}
				if (!check(value)) throw new TypeError(`Invalid field '${name}'`);
				set[name] = cloneJsonValue(value);
			}
			return { set, unset };
		},
	};
}

export function compileValueDefinition(
	schema: TSchema,
): CompiledValueDefinition {
	const recognized = recognize(schema);
	if (recognized === null || recognized.kind === 'reference') {
		throw new Error('Unsupported value definition');
	}
	const check = compile(recognized.schema);
	return {
		project(value, address) {
			return check(value)
				? Ok(structuredClone(value))
				: LensReadError.NonconformingValue({
						...address,
						raw: structuredClone(value),
					});
		},
		validate(value) {
			if (!check(value)) throw new TypeError('Invalid value');
			return cloneJsonValue(value);
		},
	};
}

function validateTable(value: Record<string, unknown>): TableDefinition {
	assertExactOptionalKeys(
		value,
		['kind', 'title', 'fields', 'optional'],
		['description'],
	);
	if (value.kind !== 'table') throw new Error('table kind is invalid');
	assertText(value.title, 'table title');
	if (value.description !== undefined) {
		assertText(value.description, 'table description');
	}
	assertPlainObject(value.fields, 'table fields');
	if (Object.hasOwn(value.fields, 'id')) {
		throw new Error("table fields cannot declare structural key 'id'");
	}
	const fields = validateSchemas(value.fields, 'fields');
	if (!Array.isArray(value.optional)) {
		throw new Error('table optional must be an array');
	}
	const optional: string[] = [];
	for (const key of value.optional) {
		if (typeof key !== 'string' || !Object.hasOwn(fields, key)) {
			throw new Error(`optional field '${String(key)}' is not declared`);
		}
		if (optional.includes(key)) {
			throw new Error(`optional field '${key}' is duplicated`);
		}
		optional.push(key);
	}
	return deepFreeze({
		kind: 'table',
		title: value.title,
		...(value.description === undefined
			? {}
			: { description: value.description }),
		fields,
		optional,
	});
}

function validateValues(value: Record<string, unknown>): ValuesDefinition {
	assertExactOptionalKeys(value, ['kind', 'title', 'values'], ['description']);
	if (value.kind !== 'values') throw new Error('values kind is invalid');
	assertText(value.title, 'values title');
	if (value.description !== undefined) {
		assertText(value.description, 'values description');
	}
	assertPlainObject(value.values, 'values');
	for (const key of Object.keys(value.values)) {
		if (!isLocalKey(key, SCALAR_SYNC_V1_LIMITS)) {
			throw new Error(`value key '${key}' is invalid`);
		}
	}
	return deepFreeze({
		kind: 'values',
		title: value.title,
		...(value.description === undefined
			? {}
			: { description: value.description }),
		values: validateSchemas(value.values, 'values'),
	});
}

function validateSchemas(
	value: Record<string, unknown>,
	label: string,
): FieldSchemas {
	const schemas: FieldSchemas = {};
	for (const [key, schema] of Object.entries(value)) {
		if (!isLocalKey(key, SCALAR_SYNC_V1_LIMITS)) {
			throw new Error(`${label} key '${key}' is invalid`);
		}
		if (containsIdentityKey(schema)) {
			throw new Error(
				`${label}.${key} contains reserved 'id' or 'key' metadata`,
			);
		}
		const recognized = recognize(schema);
		if (recognized === null || recognized.kind === 'reference') {
			throw new Error(`${label}.${key} is not a supported Epicenter field`);
		}
		schemas[key] = structuredClone(schema) as TSchema;
	}
	return deepFreeze(schemas);
}

function containsIdentityKey(value: unknown): boolean {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		(Object.hasOwn(value, 'id') || Object.hasOwn(value, 'key'))
	);
}

function cloneSchemas<TSchemas extends FieldSchemas>(
	schemas: TSchemas,
): TSchemas {
	return JSON.parse(JSON.stringify(schemas)) as TSchemas;
}

function cloneJsonValue(value: unknown): JsonValue {
	if (!isJsonValue(value, SCALAR_SYNC_V1_LIMITS)) {
		throw new TypeError('Value must be finite JSON');
	}
	return structuredClone(value);
}

function assertText(value: unknown, label: string): asserts value is string {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		!isWellFormedString(value)
	) {
		throw new Error(`${label} must be a nonempty well-formed string`);
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
		throw new Error(`${label} must be a plain object`);
	}
}

function assertExactKeys(
	value: unknown,
	keys: readonly string[],
): asserts value is Record<string, unknown> {
	assertPlainObject(value, 'value');
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		throw new Error(`expected exactly ${expected.join(', ')}`);
	}
}

function assertExactOptionalKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[],
): void {
	for (const key of required) {
		if (!Object.hasOwn(value, key)) throw new Error(`missing '${key}'`);
	}
	const allowed = new Set([...required, ...optional]);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`unknown '${key}'`);
	}
}
