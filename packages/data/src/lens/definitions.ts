import { recognize } from '@epicenter/field';
import type { Static, TSchema } from 'typebox';

import { isLensLocalKey, isLensNamespace, isLensValuesKey } from './grammar.js';

type FieldSchemas = Record<string, TSchema>;
type CollectionDefinition = TableDefinition | ValuesDefinition;
type CollectionDefinitions = Record<string, CollectionDefinition>;

type OptionalFieldNames<TTable extends TableDefinition> =
	TTable extends TableDefinition<infer TFields, infer TOptional>
		? Extract<TOptional[number], keyof TFields>
		: never;
type RequiredFieldNames<TTable extends TableDefinition> = Exclude<
	keyof TTable['fields'],
	OptionalFieldNames<TTable>
>;
type FieldsFor<TTable extends TableDefinition> = {
	[K in RequiredFieldNames<TTable>]: Static<TTable['fields'][K]>;
} & {
	[K in OptionalFieldNames<TTable>]?: Static<TTable['fields'][K]>;
};

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

export type LensDefinition<
	TCollections extends CollectionDefinitions = CollectionDefinitions,
> = {
	namespace: string;
	title: string;
	description: string;
	collections: TCollections;
};

export type RowFor<TTable extends TableDefinition> = {
	id: string;
} & FieldsFor<TTable>;

export type CreateInputFor<TTable extends TableDefinition> =
	FieldsFor<TTable> & {
		id?: never;
	};

export type ConstrainedUpdate<
	TTable extends TableDefinition,
	TChanges extends Record<string, unknown>,
> = Record<Exclude<keyof TChanges, keyof TTable['fields']>, never> & {
	[K in keyof TChanges]: K extends keyof TTable['fields']
		? K extends OptionalFieldNames<TTable>
			? Static<TTable['fields'][K]> | undefined
			: Static<TTable['fields'][K]>
		: never;
};

export type ValueTypeFor<
	TValues extends ValuesDefinition,
	TKey extends keyof TValues['values'],
> = Static<TValues['values'][TKey]>;

/**
 * Defines one pure-JSON table collection.
 *
 * The `kind` member is the minimal persisted discriminant needed to distinguish
 * ADR-0168's two definition kinds inside its single `collections` map.
 */
export function defineTable<
	const TFields extends FieldSchemas,
	const TOptional extends readonly (keyof TFields & string)[] = readonly [],
>({
	title,
	description,
	fields: authoredFields,
	optional = [] as unknown as TOptional,
}: {
	title: string;
	description?: string;
	fields: TFields & { id?: never; key?: never };
	optional?: TOptional;
}): TableDefinition<TFields, TOptional> {
	assertString(title, 'Table title');
	if (description !== undefined) assertString(description, 'Table description');
	const fields = canonicalizeFields(authoredFields, 'fields');
	const seen = new Set<string>();
	for (const name of optional) {
		if (typeof name !== 'string' || !Object.hasOwn(fields, name)) {
			throw new Error(`Unknown optional field '${String(name)}'`);
		}
		if (seen.has(name)) throw new Error(`Duplicate optional field '${name}'`);
		seen.add(name);
	}

	return deepFreeze({
		kind: 'table',
		title,
		...(description === undefined ? {} : { description }),
		fields,
		optional: [...optional],
	}) as TableDefinition<TFields, TOptional>;
}

/**
 * Defines one pure-JSON named-values collection.
 *
 * The `kind` member is the minimal persisted discriminant needed to distinguish
 * ADR-0168's two definition kinds inside its single `collections` map.
 */
export function defineValues<const TValues extends FieldSchemas>({
	title,
	description,
	values: authoredValues,
}: {
	title: string;
	description?: string;
	values: TValues;
}): ValuesDefinition<TValues> {
	assertString(title, 'Values title');
	if (description !== undefined)
		assertString(description, 'Values description');
	const values = canonicalizeFields(authoredValues, 'values', 'values');
	return deepFreeze({
		kind: 'values',
		title,
		...(description === undefined ? {} : { description }),
		values,
	}) as ValuesDefinition<TValues>;
}

/** Defines a complete, canonical, deeply frozen pure-JSON Lens. */
export function defineLens<const TCollections extends CollectionDefinitions>({
	namespace,
	title,
	description,
	collections: authoredCollections,
}: {
	namespace: string;
	title: string;
	description: string;
	collections: TCollections;
}): LensDefinition<TCollections> {
	if (!isLensNamespace(namespace)) {
		throw new Error(`Invalid Lens namespace '${namespace}'`);
	}
	assertString(title, 'Lens title');
	assertString(description, 'Lens description');
	assertPlainObject(authoredCollections, 'Lens collections');
	for (const [key, collection] of Object.entries(authoredCollections)) {
		assertLocalKey(key, 'collection');
		assertCanonicalCollection(collection, key);
	}
	const collections = cloneJson(authoredCollections);
	return deepFreeze({
		namespace,
		title,
		description,
		collections,
	}) as LensDefinition<TCollections>;
}

function canonicalizeFields<TFields extends FieldSchemas>(
	authoredFields: TFields,
	label: string,
	kind: 'fields' | 'values' = 'fields',
): TFields {
	assertPlainObject(authoredFields, label);
	const fields: FieldSchemas = {};
	for (const [name, authoredSchema] of Object.entries(authoredFields)) {
		if (kind === 'values') {
			if (!isLensValuesKey(name))
				throw new Error(`Invalid value key '${name}'`);
		} else {
			assertLocalKey(name, 'field');
			assertNotReserved(name, `Field '${name}'`);
		}
		const schema = cloneJson(authoredSchema);
		const nestedReserved = findNestedReservedProperty(schema);
		if (nestedReserved !== null) {
			throw new Error(
				`Field '${name}' schema contains reserved property '${nestedReserved}'`,
			);
		}
		if (recognize(schema) === null) {
			throw new Error(`Field '${name}' must use the field.* vocabulary`);
		}
		fields[name] = deepFreeze(schema);
	}
	return fields as TFields;
}

function assertCanonicalCollection(value: unknown, key: string): void {
	assertPlainObject(value, `Collection '${key}'`);
	if (value.kind !== 'table' && value.kind !== 'values') {
		throw new Error(
			`Collection '${key}' must be defined with defineTable or defineValues`,
		);
	}
}

function assertLocalKey(value: string, label: string): void {
	if (!isLensLocalKey(value))
		throw new Error(`Invalid ${label} key '${value}'`);
}

function assertNotReserved(value: string, label: string): void {
	if (value.toLowerCase() === 'id' || value.toLowerCase() === 'key') {
		throw new Error(`${label} uses reserved name '${value}'`);
	}
}

function findNestedReservedProperty(value: unknown): 'id' | 'key' | null {
	if (value === null || typeof value !== 'object') return null;
	for (const [key, child] of Object.entries(value)) {
		const lower = key.toLowerCase();
		if (lower === 'id' || lower === 'key') return lower;
		const nested = findNestedReservedProperty(child);
		if (nested !== null) return nested;
	}
	return null;
}

function assertString(value: unknown, label: string): asserts value is string {
	if (typeof value !== 'string')
		throw new TypeError(`${label} must be a string`);
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

function cloneJson<TValue>(value: TValue): TValue {
	return JSON.parse(JSON.stringify(value)) as TValue;
}

export function deepFreeze<TValue>(value: TValue): TValue {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
		return value;
	}
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}
