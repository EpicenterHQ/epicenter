import { recognize } from '@epicenter/field';
import { Ok, type Result } from 'wellcrafted/result';

import {
	deepFreeze,
	type LensDefinition,
	type TableDefinition,
	type ValuesDefinition,
} from './definitions.js';
import { LensParseError } from './errors.js';
import { isLensLocalKey, isLensNamespace, isLensValuesKey } from './grammar.js';

/** Parses arbitrary JSON under the single closed Lens legitimacy law. */
export function parseLens(
	value: unknown,
): Result<LensDefinition, LensParseError> {
	if (!isPureJson(value)) {
		return LensParseError.InvalidShape({ path: 'lens', expected: 'pure JSON' });
	}
	if (
		!isPlainObject(value) ||
		!hasExactKeys(value, ['namespace', 'title', 'description', 'collections'])
	) {
		return LensParseError.InvalidShape({
			path: 'lens',
			expected:
				'a closed object with namespace, title, description, and collections',
		});
	}
	if (typeof value.namespace !== 'string') {
		return LensParseError.InvalidShape({
			path: 'lens.namespace',
			expected: 'a string',
		});
	}
	if (!isLensNamespace(value.namespace)) {
		return LensParseError.InvalidNamespace({ namespace: value.namespace });
	}
	if (typeof value.title !== 'string') {
		return LensParseError.InvalidShape({
			path: 'lens.title',
			expected: 'a string',
		});
	}
	if (typeof value.description !== 'string') {
		return LensParseError.InvalidShape({
			path: 'lens.description',
			expected: 'a string',
		});
	}
	if (!isPlainObject(value.collections)) {
		return LensParseError.InvalidShape({
			path: 'lens.collections',
			expected: 'a plain object',
		});
	}

	const collections: Record<string, TableDefinition | ValuesDefinition> = {};
	for (const [collectionKey, collection] of Object.entries(value.collections)) {
		const path = `lens.collections.${collectionKey}`;
		if (!isLensLocalKey(collectionKey)) {
			return LensParseError.InvalidLocalKey({
				path: 'lens.collections',
				key: collectionKey,
			});
		}
		if (
			!isPlainObject(collection) ||
			(collection.kind !== 'table' && collection.kind !== 'values')
		) {
			return LensParseError.InvalidShape({
				path,
				expected: 'a table or values collection',
			});
		}
		const parsed =
			collection.kind === 'table'
				? parseTable(collection, path)
				: parseValues(collection, path);
		if (parsed.error !== null) return parsed;
		collections[collectionKey] = parsed.data;
	}

	return Ok(
		deepFreeze({
			namespace: value.namespace,
			title: value.title,
			description: value.description,
			collections,
		}),
	);
}

function parseTable(
	value: Record<string, unknown>,
	path: string,
): Result<TableDefinition, LensParseError> {
	if (
		!hasExactKeys(
			value,
			['kind', 'title', 'fields', 'optional'],
			['description'],
		)
	) {
		return LensParseError.InvalidShape({
			path,
			expected: 'a closed table definition',
		});
	}
	const metadataError = validateCollectionMetadata(value, path);
	if (metadataError !== null) return metadataError;
	if (!isPlainObject(value.fields)) {
		return LensParseError.InvalidShape({
			path: `${path}.fields`,
			expected: 'a plain object',
		});
	}
	const fieldsResult = parseFieldMap(value.fields, `${path}.fields`, false);
	if (fieldsResult.error !== null) return fieldsResult;
	if (
		!Array.isArray(value.optional) ||
		!value.optional.every((entry) => typeof entry === 'string')
	) {
		return LensParseError.InvalidShape({
			path: `${path}.optional`,
			expected: 'an array of strings',
		});
	}
	const seen = new Set<string>();
	for (const field of value.optional) {
		if (!Object.hasOwn(fieldsResult.data, field)) {
			return LensParseError.UnknownOptionalField({
				path: `${path}.optional`,
				field,
			});
		}
		if (seen.has(field)) {
			return LensParseError.DuplicateOptionalField({
				path: `${path}.optional`,
				field,
			});
		}
		seen.add(field);
	}
	return Ok(
		deepFreeze({
			kind: 'table' as const,
			title: value.title as string,
			...(value.description === undefined
				? {}
				: { description: value.description as string }),
			fields: fieldsResult.data,
			optional: [...value.optional],
		}),
	);
}

function parseValues(
	value: Record<string, unknown>,
	path: string,
): Result<ValuesDefinition, LensParseError> {
	if (!hasExactKeys(value, ['kind', 'title', 'values'], ['description'])) {
		return LensParseError.InvalidShape({
			path,
			expected: 'a closed values definition',
		});
	}
	const metadataError = validateCollectionMetadata(value, path);
	if (metadataError !== null) return metadataError;
	if (!isPlainObject(value.values)) {
		return LensParseError.InvalidShape({
			path: `${path}.values`,
			expected: 'a plain object',
		});
	}
	const valuesResult = parseFieldMap(value.values, `${path}.values`, true);
	if (valuesResult.error !== null) return valuesResult;
	return Ok(
		deepFreeze({
			kind: 'values' as const,
			title: value.title as string,
			...(value.description === undefined
				? {}
				: { description: value.description as string }),
			values: valuesResult.data,
		}),
	);
}

function parseFieldMap(
	value: Record<string, unknown>,
	path: string,
	isValueMap: boolean,
): Result<Record<string, import('typebox').TSchema>, LensParseError> {
	const parsed: Record<string, import('typebox').TSchema> = {};
	for (const [key, schema] of Object.entries(value)) {
		const fieldPath = `${path}.${key}`;
		if (!(isValueMap ? isLensValuesKey(key) : isLensLocalKey(key))) {
			return LensParseError.InvalidLocalKey({ path, key });
		}
		if (
			!isValueMap &&
			(key.toLowerCase() === 'id' || key.toLowerCase() === 'key')
		) {
			return LensParseError.ReservedName({ path, key });
		}
		if (!isPureJson(schema)) {
			return LensParseError.InvalidShape({
				path: fieldPath,
				expected: 'pure JSON',
			});
		}
		const nested = findReservedProperty(schema);
		if (nested !== null) {
			return LensParseError.NestedReservedProperty({
				path: fieldPath,
				property: nested,
			});
		}
		if (recognize(schema) === null) {
			return LensParseError.UnrecognizedField({ path: fieldPath });
		}
		parsed[key] = structuredClone(schema) as import('typebox').TSchema;
	}
	return Ok(parsed);
}

function validateCollectionMetadata(
	value: Record<string, unknown>,
	path: string,
): ReturnType<typeof LensParseError.InvalidShape> | null {
	if (typeof value.title !== 'string') {
		return LensParseError.InvalidShape({
			path: `${path}.title`,
			expected: 'a string',
		});
	}
	if (
		value.description !== undefined &&
		typeof value.description !== 'string'
	) {
		return LensParseError.InvalidShape({
			path: `${path}.description`,
			expected: 'a string',
		});
	}
	return null;
}

function hasExactKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean {
	const keys = Object.keys(value);
	return (
		required.every((key) => Object.hasOwn(value, key)) &&
		keys.every((key) => required.includes(key) || optional.includes(key))
	);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		(Object.getPrototypeOf(value) === Object.prototype ||
			Object.getPrototypeOf(value) === null)
	);
}

function isPureJson(value: unknown, seen = new Set<object>()): boolean {
	if (value === null || typeof value === 'string' || typeof value === 'boolean')
		return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (typeof value !== 'object' || seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) {
		const keys = Reflect.ownKeys(value);
		if (keys.some((key) => typeof key === 'symbol')) return false;
		if (keys.length !== value.length + 1 || keys.at(-1) !== 'length')
			return false;
		return value.every(
			(child, index) => Object.hasOwn(value, index) && isPureJson(child, seen),
		);
	}
	if (!isPlainObject(value)) return false;
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key === 'symbol') return false;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (
			descriptor === undefined ||
			!descriptor.enumerable ||
			!('value' in descriptor)
		)
			return false;
		if (!isPureJson(descriptor.value, seen)) return false;
	}
	return true;
}

function findReservedProperty(value: unknown): string | null {
	if (value === null || typeof value !== 'object') return null;
	for (const [key, child] of Object.entries(value)) {
		if (key.toLowerCase() === 'id' || key.toLowerCase() === 'key') return key;
		const nested = findReservedProperty(child);
		if (nested !== null) return nested;
	}
	return null;
}
