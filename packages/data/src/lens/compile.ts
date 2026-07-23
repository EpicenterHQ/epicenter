import { compile, recognize } from '@epicenter/field';
import { Ok, type Result } from 'wellcrafted/result';

import { isJsonValue } from '../protocol/index.js';
import type { JsonObject, JsonValue } from '../protocol/v1/index.js';
import type {
	LensDefinition,
	RowFor,
	TableDefinition,
	ValuesDefinition,
	ValueTypeFor,
} from './definitions.js';
import {
	type ConformanceIssue,
	LensReadError,
	type NonconformingRowError,
	type NonconformingValueError,
} from './errors.js';

export type NormalizedUpdate = {
	set: JsonObject;
	unset: string[];
};

export type CompiledTable<TTable extends TableDefinition = TableDefinition> = {
	project(
		id: string,
		payload: JsonObject,
	): Result<RowFor<TTable>, NonconformingRowError>;
	validateCreate(input: Record<string, unknown>): JsonObject;
	normalizeUpdate(input: Record<string, unknown>): NormalizedUpdate;
};

export type CompiledValue<TValue = unknown> = {
	project(value: JsonValue): Result<TValue, NonconformingValueError>;
	validate(value: unknown): JsonValue;
};

type CompiledValues<TValues extends ValuesDefinition> = {
	[TKey in keyof TValues['values']]: CompiledValue<ValueTypeFor<TValues, TKey>>;
};

export type CompiledLens<TLens extends LensDefinition = LensDefinition> = {
	[TKey in keyof TLens['collections']]: TLens['collections'][TKey] extends TableDefinition
		? CompiledTable<TLens['collections'][TKey]>
		: TLens['collections'][TKey] extends ValuesDefinition
			? CompiledValues<TLens['collections'][TKey]>
			: never;
};

/** Compiles disposable validators solely from a valid Lens's JSON data. */
export function compileLens<const TLens extends LensDefinition>(
	lens: TLens,
): CompiledLens<TLens> {
	const compiledCollections: Record<string, unknown> = {};
	for (const [collectionKey, collection] of Object.entries(lens.collections)) {
		if (collection.kind === 'table') {
			compiledCollections[collectionKey] = compileTable(
				collectionKey,
				collection,
			);
			continue;
		}
		const values: Record<string, CompiledValue> = {};
		for (const [valueKey, schema] of Object.entries(collection.values)) {
			values[valueKey] = compileValue(`${collectionKey}.${valueKey}`, schema);
		}
		compiledCollections[collectionKey] = Object.freeze(values);
	}
	return Object.freeze(compiledCollections) as CompiledLens<TLens>;
}

function compileTable(key: string, table: TableDefinition): CompiledTable {
	const fields = new Map(
		Object.entries(table.fields).map(([name, schema]) => {
			const recognized = recognize(schema);
			if (recognized === null)
				throw new Error(`Invalid parsed field '${name}'`);
			return [name, compile(recognized.schema)] as const;
		}),
	);
	const optional = new Set<string>(table.optional);
	return Object.freeze({
		project(id: string, payload: JsonObject) {
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
				? Ok(projected as RowFor<TableDefinition>)
				: LensReadError.NonconformingRow({
						key,
						id,
						raw: structuredClone(payload),
						issues,
					});
		},
		validateCreate(input: Record<string, unknown>) {
			assertPlainObject(input, 'Create input');
			const payload: JsonObject = {};
			for (const name of Object.keys(input)) {
				if (!fields.has(name)) throw new TypeError(`Unknown field '${name}'`);
			}
			for (const [name, check] of fields) {
				if (!Object.hasOwn(input, name) || input[name] === undefined) {
					if (!optional.has(name))
						throw new TypeError(`Missing required field '${name}'`);
					continue;
				}
				const value = input[name];
				if (!check(value)) throw new TypeError(`Invalid field '${name}'`);
				payload[name] = cloneJsonValue(value);
			}
			return payload;
		},
		normalizeUpdate(input: Record<string, unknown>) {
			assertPlainObject(input, 'Update input');
			const set: JsonObject = {};
			const unset: string[] = [];
			for (const [name, value] of Object.entries(input)) {
				const check = fields.get(name);
				if (check === undefined) throw new TypeError(`Unknown field '${name}'`);
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
	});
}

function compileValue(
	key: string,
	schema: import('typebox').TSchema,
): CompiledValue {
	const recognized = recognize(schema);
	if (recognized === null) throw new Error(`Invalid parsed value '${key}'`);
	const check = compile(recognized.schema);
	return Object.freeze({
		project(value: JsonValue) {
			return check(value)
				? Ok(structuredClone(value))
				: LensReadError.NonconformingValue({
						key,
						raw: structuredClone(value),
					});
		},
		validate(value: unknown) {
			if (!check(value)) throw new TypeError(`Invalid value for '${key}'`);
			return cloneJsonValue(value);
		},
	});
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

function cloneJsonValue(value: unknown): JsonValue {
	if (!isJsonValue(value)) throw new TypeError('Value must be finite JSON');
	return structuredClone(value);
}
