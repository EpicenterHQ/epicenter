/**
 * Prepare developer declarations for reading.
 *
 * A field is a native TypeBox schema, and a prepared schema has the shape
 * it was declared in: each table's `fields` is a record of native schemas.
 * Preparation adds what a declaration cannot say by itself: usable names, an
 * owned frozen snapshot of each schema, and TypeBox's compiled validator for
 * that snapshot, held privately beside it.
 *
 * A prepared field is plain JSON: the schema a file holds, frozen, so a
 * declaration in code and the same declaration read from a file validate
 * alike. Preparation refuses what JSON cannot hold, including native
 * callbacks.
 *
 * The one read is {@link check}. It asks whether a value is JSON before the
 * schema's validator sees it, and never changes the value it is given. A
 * `default` annotation is inert: nothing fills a missing value. Absence is an
 * issue only for a required field; a `field.optional` field may be absent.
 * The `settings` table declares only `field.optional` fields.
 */

import { type TSchema, Type } from 'typebox';
import { Compile } from 'typebox/compile';
import { Format } from 'typebox/format';
import { Resolve } from 'typebox/schema';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result, trySync } from 'wellcrafted/result';
import type {
	ConformanceIssue,
	DataSchema,
	FieldMap,
	TableDeclaration,
} from './declaration.js';
import { isJsonSafe, type JsonObject, type JsonValue } from './json.js';
import { isTableName } from './table-name.js';

export const DataDefinitionParseError = defineErrors({
	Malformed: ({ reason }: { reason: string }) => ({
		message: `This data definition is not well formed: ${reason}`,
		reason,
	}),
	UnrecognizedField: ({
		table,
		field,
		reason,
	}: {
		table: string;
		field: string;
		reason: string;
	}) => ({
		message: `Field '${table}.${field}' is not a usable field: ${reason}`,
		table,
		field,
		reason,
	}),
});
export type DataDefinitionParseError = InferErrors<
	typeof DataDefinitionParseError
>;

export type Conformance = {
	conforming: JsonObject;
	issues: ConformanceIssue[];
};

const preparedSchemas = new WeakMap<
	object,
	Result<DataSchema, DataDefinitionParseError>
>();

/**
 * Check one schema and return the copy every read uses (ADR-0266).
 *
 * The result has the declared shape and the declared type: an optional
 * `title` and `local`, and `tables`, each table holding `fields` and, when it
 * is closed, `additionalProperties`. It is owned here. Every field is the
 * declared schema's frozen JSON (see `plainSchema`). `tables` and each
 * `fields` are frozen records without a prototype, so a name like
 * `constructor` reads as its own entry or as nothing. A top-level key the
 * shape does not name is not read.
 *
 * A schema names no dataset: a declaration with an own `id` is malformed.
 *
 * Names come from the record keys and are stored nowhere else. No field or
 * table name can be an integer, so a record keeps its declaration order.
 *
 * Memoised on object identity, for the declaration handed in and for the
 * schema handed back, so preparing a prepared schema returns it. Identity
 * keying means a declaration MUTATED IN PLACE reads back its old preparation.
 * That is the intent: the prepared schema is a snapshot.
 */
export function prepareSchema<
	TSchema extends DataSchema & { readonly id?: never },
>(value: TSchema): Result<TSchema, DataDefinitionParseError> {
	return memoised(value) as Result<TSchema, DataDefinitionParseError>;
}

function memoised(
	value: unknown,
): Result<DataSchema, DataDefinitionParseError> {
	// A declaration that arrived untyped may not be an object, and only an
	// object can be a memo key.
	if (typeof value !== 'object' || value === null) return prepareRoot(value);
	const found = preparedSchemas.get(value);
	if (found !== undefined) return found;
	const result = prepareRoot(value);
	preparedSchemas.set(value, result);
	if (result.error === null) preparedSchemas.set(result.data, result);
	return result;
}

function prepareRoot(
	value: unknown,
): Result<DataSchema, DataDefinitionParseError> {
	if (!isPlainObject(value))
		return DataDefinitionParseError.Malformed({
			reason: 'it is not a plain object',
		});
	if (Object.hasOwn(value, 'id'))
		return DataDefinitionParseError.Malformed({
			reason: 'it declares an id, and a schema names no dataset',
		});
	return prepareShape(value);
}

/** The prepared title, local patterns, and tables of a plain-object declaration. */
function prepareShape(
	value: Record<string, unknown>,
): Result<DataSchema, DataDefinitionParseError> {
	const { title, tables, local } = value as Partial<DataSchema>;
	if (
		title !== undefined &&
		(typeof title !== 'string' || title.trim() === '')
	) {
		return DataDefinitionParseError.Malformed({
			reason: 'its title must say something or be absent',
		});
	}
	const localProblem = local === undefined ? undefined : localProblemOf(local);
	if (localProblem !== undefined)
		return DataDefinitionParseError.Malformed({ reason: localProblem });
	if (!isPlainObject(tables))
		return DataDefinitionParseError.Malformed({
			reason: 'it declares no tables',
		});

	const preparedTables: Record<string, TableDeclaration> = Object.create(null);
	const foldedNames = new Set<string>();
	for (const [tableName, declaration] of Object.entries(tables)) {
		if (!isTableName(tableName)) {
			return DataDefinitionParseError.Malformed({
				reason: `table name '${tableName}' is not usable`,
			});
		}
		const folded = tableName.toLowerCase();
		if (foldedNames.has(folded)) {
			return DataDefinitionParseError.Malformed({
				reason: `table names collide case-insensitively: '${tableName}'`,
			});
		}
		foldedNames.add(folded);
		if (!isPlainObject(declaration)) {
			return DataDefinitionParseError.Malformed({
				reason: `table '${tableName}' must declare fields`,
			});
		}
		const table = declaration as TableDeclaration;
		if (
			Object.keys(table).some(
				(key) => key !== 'fields' && key !== 'additionalProperties',
			)
		) {
			return DataDefinitionParseError.Malformed({
				reason: `table '${tableName}' declares an unknown option`,
			});
		}
		if (Object.hasOwn(table, 'additionalProperties')) {
			if (table.additionalProperties !== false)
				return DataDefinitionParseError.Malformed({
					reason: `table '${tableName}' declares additionalProperties; the only value is false, which closes the table`,
				});
		}
		const fields = prepareFields(tableName, table.fields);
		if (fields.error !== null) return fields;
		// One declared table reused under two names is prepared once per name.
		preparedTables[tableName] = Object.freeze({
			fields: fields.data,
			...(table.additionalProperties === false
				? { additionalProperties: false as const }
				: {}),
		});
	}
	return Ok(
		Object.freeze({
			...(title === undefined ? {} : { title }),
			// Sorted and once each, so a declaration's bytes do not depend on
			// the order its patterns were written in.
			...(local === undefined
				? {}
				: { local: Object.freeze([...new Set(local)].sort()) }),
			// `defineTable`'s mark is a type and nothing at run time.
			tables: Object.freeze(preparedTables) as DataSchema['tables'],
		}),
	);
}

/**
 * Why `local` cannot be written as `.gitignore` lines, or `undefined`. A
 * negation is refused because a storage appends a missing pattern after a
 * person's own lines, so what it would re-include is not the schema's to
 * decide.
 */
function localProblemOf(local: unknown): string | undefined {
	if (!Array.isArray(local))
		return 'its local must be a list of .gitignore patterns';
	for (const pattern of local) {
		if (typeof pattern !== 'string' || pattern === '')
			return 'each local pattern must be a nonempty string';
		if (/[\r\n]/.test(pattern))
			return `the local pattern '${pattern}' must be one line`;
		if (pattern.trim() !== pattern)
			return `the local pattern '${pattern}' has surrounding whitespace`;
		if (pattern.startsWith('#') || pattern.startsWith('!'))
			return `the local pattern '${pattern}' must ignore files; it cannot be a comment or a negation`;
	}
	return undefined;
}

function prepareFields(
	tableName: string,
	declaration: unknown,
): Result<FieldMap, DataDefinitionParseError> {
	if (!isPlainObject(declaration))
		return DataDefinitionParseError.Malformed({
			reason: `table '${tableName}' does not declare a flat field map`,
		});
	const fields: Record<string, TSchema & object> = Object.create(null);
	for (const [fieldName, declared] of Object.entries(declaration)) {
		if (
			fieldName.toLowerCase() === 'id' ||
			!/^[A-Za-z!][A-Za-z0-9_!]*$/.test(fieldName)
		) {
			return DataDefinitionParseError.Malformed({
				reason: `field name '${tableName}.${fieldName}' is not usable`,
			});
		}
		const unrecognized = (reason: string) =>
			DataDefinitionParseError.UnrecognizedField({
				table: tableName,
				field: fieldName,
				reason,
			});
		if (!isPlainObject(declared))
			return unrecognized('a field is a TypeBox schema');
		const problem = schemaProblem(declared);
		if (problem !== undefined) return unrecognized(problem);
		const field = trySync({
			try: () => {
				const schema = plainSchema(declared, Type.IsOptional(declared));
				validators.set(schema, Compile(schema));
				return schema;
			},
			catch: (cause) => unrecognized(String(cause)),
		});
		if (field.error) return field;
		fields[fieldName] = field.data;
	}
	return Ok(Object.freeze(fields));
}

/**
 * The compiled validator of each prepared field, keyed on the field itself.
 * Every preparation makes a fresh field, so a declared schema reused under
 * two names or in two definitions has two entries.
 */
const validators = new WeakMap<object, ReturnType<typeof Compile>>();

/**
 * The validator of a prepared field. A schema this module did not prepare
 * has none; that is a programmer error and throws.
 */
function validatorOf(schema: TSchema & object): ReturnType<typeof Compile> {
	const validator = validators.get(schema);
	if (validator === undefined)
		throw new Error(
			'This schema was not prepared. Read fields from the schema that prepareSchema or defineFolder returned.',
		);
	return validator;
}

/** Whether a row may leave this prepared field out (`field.optional`). */
export function isOptional(schema: TSchema & object): boolean {
	return Type.IsOptional(schema);
}

/**
 * What {@link check} asks of the values it is given:
 *
 * - `read`: a stored payload. A key the fields do not declare is ignored.
 * - `input`: a whole row being written. An undeclared key is an issue.
 * - `patch`: some fields being written. An undeclared key is an issue and an
 *   absent field is not.
 *
 * In every mode an absent required field is an issue, except `patch`, and an
 * absent optional field is not. A top-level key holding `undefined` is
 * absent; inside a value, `undefined` is not JSON and is an issue.
 */
export type CheckMode = 'read' | 'input' | 'patch';

/**
 * Check values against prepared fields, one field at a time, so a field that
 * fails never takes a valid one with it. `conforming` holds each present
 * field whose value is JSON and passes its own validator, as the caller's own
 * values; `issues` holds everything else, field by field.
 *
 * A value is asked whether it is JSON before its schema sees it: a schema can
 * be structural about what it admits (`Type.Any()` admits a `Date`), and a
 * recursive schema would follow a cyclic value until the stack overflows.
 * `Check` decides validity; `Errors` only describes a failure.
 */
export function check(
	fields: FieldMap,
	values: Readonly<Record<string, unknown>>,
	mode: CheckMode,
): Conformance {
	const conforming: JsonObject = {};
	const issues: ConformanceIssue[] = [];
	for (const [fieldName, schema] of Object.entries(fields)) {
		const value = Object.hasOwn(values, fieldName)
			? values[fieldName]
			: undefined;
		if (value === undefined) {
			if (mode !== 'patch' && !isOptional(schema))
				issues.push({ field: fieldName, message: `${fieldName} is missing` });
			continue;
		}
		const found = fieldIssues(fieldName, schema, value);
		if (found.length === 0) conforming[fieldName] = value as JsonValue;
		else issues.push(...found);
	}
	if (mode !== 'read')
		// An own entry only: a prototype declares nothing.
		for (const key of Object.keys(values))
			if (!Object.hasOwn(fields, key) && values[key] !== undefined)
				issues.push({ field: key, message: `${key} is not declared` });
	return { conforming, issues };
}

/**
 * Why one present value fails its field: that it is not JSON, or TypeBox's
 * own errors with the paths that can be walked in the value. Empty when the
 * value conforms.
 */
function fieldIssues(
	name: string,
	schema: TSchema & object,
	value: unknown,
): ConformanceIssue[] {
	const validator = validatorOf(schema);
	const subject = `${name} does not conform`;
	if (!isJsonSafe(value))
		return [{ field: name, message: `${subject}: must be a JSON value` }];
	return trySync({
		try: (): ConformanceIssue[] => {
			if (validator.Check(value)) return [];
			const errors = validator.Errors(value);
			if (errors.length === 0) return [{ field: name, message: subject }];
			return errors.map((error) => {
				const path = verifiedPointer(value, error.instancePath);
				return path === undefined
					? { field: name, message: `${subject}: ${error.message}` }
					: {
							field: name,
							path,
							message: `${subject} at ${path}: ${error.message}`,
						};
			});
		},
		// Deep recursion can still exhaust the stack; it stays with this field.
		catch: () =>
			Ok([{ field: name, message: `${subject}: schema validation threw` }]),
	}).data;
}

// Compare against TypeBox's stock handlers, not a registry that an
// application may have changed before this module was imported.
const PORTABLE_FORMATS = new Map<string, (value: string) => boolean>([
	['date-time', Format.IsDateTime],
	['date', Format.IsDate],
	['duration', Format.IsDuration],
	['email', Format.IsEmail],
	['hostname', Format.IsHostname],
	['idn-email', Format.IsIdnEmail],
	['idn-hostname', Format.IsIdnHostname],
	['ipv4', Format.IsIPv4],
	['ipv6', Format.IsIPv6],
	['iri-reference', Format.IsIriReference],
	['iri', Format.IsIri],
	['json-pointer-uri-fragment', Format.IsJsonPointerUriFragment],
	['json-pointer', Format.IsJsonPointer],
	['regex', Format.IsRegex],
	['relative-json-pointer', Format.IsRelativeJsonPointer],
	['time', Format.IsTime],
	['uri-reference', Format.IsUriReference],
	['uri-template', Format.IsUriTemplate],
	['uri', Format.IsUri],
	['url', Format.IsUrl],
	['uuid', Format.IsUuid],
]);

/** Keywords whose value is data, never a schema. */
const DATA_KEYWORDS = new Set(['default', 'const', 'enum', 'examples']);
/** Keywords whose value maps names to schemas. */
const SCHEMA_MAP_KEYWORDS = new Set([
	'properties',
	'patternProperties',
	'$defs',
	'definitions',
	'dependentSchemas',
	'dependencies',
]);
/** Keywords whose value is a schema or a list of schemas. */
const SCHEMA_KEYWORDS = new Set([
	'items',
	'prefixItems',
	'additionalItems',
	'additionalProperties',
	'unevaluatedItems',
	'unevaluatedProperties',
	'contains',
	'propertyNames',
	'not',
	'if',
	'then',
	'else',
	'anyOf',
	'allOf',
	'oneOf',
]);

/**
 * Why a declared schema cannot be a field, or `undefined` when it can. A field
 * is JSON, so the file it is written to validates exactly as the field does:
 *
 * - no function anywhere, which is how a refinement, guard, or codec is held;
 * - only plain objects and dense arrays, with enumerable data properties and
 *   no symbol keys, because anything else would not survive being written;
 * - finite numbers;
 * - a `format` only from the portable set, at a schema position. TypeBox
 *   passes every value for a format it does not know, so a misspelled format
 *   would check nothing;
 * - a `$ref` that resolves, the way TypeBox resolves it, to a schema inside
 *   the field. A reference to nothing fails every value, so every row would
 *   read as invalid.
 *
 * TypeBox's own hidden `~` keywords are allowed and left behind; a visible
 * `~` key is refused, so optionality has one spelling in a file: `required`.
 */
function schemaProblem(declared: object): string | undefined {
	const seen = new Set<object>();
	const visit = (
		node: unknown,
		path: string,
		position: 'schema' | 'data',
		// The nearest schema with an `$id`, which a `#` reference resolves
		// against, as TypeBox's compiler does; the field itself without one.
		base: object = declared,
	): string | undefined => {
		if (typeof node === 'function') return `${path} holds a runtime callback`;
		if (typeof node === 'number' && !Number.isFinite(node))
			return `${path} is not a finite number`;
		if (typeof node !== 'object' || node === null) return undefined;
		if (seen.has(node)) return `${path} refers back to itself`;
		if (!Array.isArray(node) && !isPlainObject(node))
			return `${path} is not plain JSON`;
		if (Object.getOwnPropertySymbols(node).length > 0)
			return `${path} has symbol keys`;
		seen.add(node);
		try {
			const array = Array.isArray(node);
			const scope =
				position === 'schema' &&
				!array &&
				typeof (node as { $id?: unknown }).$id === 'string'
					? node
					: base;
			for (const key of Object.getOwnPropertyNames(node)) {
				if (array && key === 'length') continue;
				const descriptor = Object.getOwnPropertyDescriptor(node, key)!;
				const at = `${path}.${key}`;
				if (!('value' in descriptor)) return `${at} is an accessor`;
				if (key.startsWith('~')) {
					if (key === '~guard' || key === '~refine' || key === '~codec')
						return `${at} is a runtime callback`;
					// TypeBox keeps its own `~` keywords hidden. A visible one in a
					// schema, such as a hand-written "~optional", would mean
					// something only here. In data it is an ordinary key.
					if (descriptor.enumerable && position === 'schema' && !array)
						return `${at} is not a JSON Schema keyword`;
					if (descriptor.enumerable) {
						const problem = visit(descriptor.value, at, 'data');
						if (problem !== undefined) return problem;
						continue;
					}
					// A hidden keyword is dropped, so it may not hide a callback.
					const hidden = visit(descriptor.value, at, 'data');
					if (hidden !== undefined) return hidden;
					continue;
				}
				if (!descriptor.enumerable) return `${at} is hidden`;
				if (array && !/^(0|[1-9][0-9]*)$/.test(key))
					return `${path} holds a non-index property`;
				const value = descriptor.value;
				// JSON drops an `undefined` member and writes `null` for an
				// `undefined` element, either of which would change the check.
				if (value === undefined && (array || key === 'const'))
					return `${at} is undefined, which JSON cannot hold`;
				let next: 'schema' | 'data' = 'data';
				let children: 'self' | 'values' = 'self';
				if (position === 'schema' && !array) {
					if (key === 'format' && typeof value === 'string') {
						const stock = PORTABLE_FORMATS.get(value);
						if (stock === undefined || Format.Get(value) !== stock)
							return `${at} is not a portable format: '${value}'`;
					}
					if (key === '$ref' && typeof value === 'string') {
						const problem = referenceProblem(declared, scope, value);
						if (problem !== undefined)
							return `${at} names '${value}', ${problem}`;
					}
					if (SCHEMA_KEYWORDS.has(key)) next = 'schema';
					else if (SCHEMA_MAP_KEYWORDS.has(key)) {
						next = 'schema';
						children = 'values';
					} else if (DATA_KEYWORDS.has(key)) next = 'data';
				} else if (position === 'schema' && array) next = 'schema';
				const problem =
					children === 'values' && isPlainObject(value)
						? Object.keys(value)
								.map((name) => visit(value[name], `${at}.${name}`, next, scope))
								.find((found) => found !== undefined)
						: visit(value, at, next, scope);
				if (problem !== undefined) return problem;
			}
			if (array && Object.keys(node).length !== (node as unknown[]).length)
				return `${path} is sparse`;
		} finally {
			seen.delete(node);
		}
		return undefined;
	};
	return visit(declared, '$', 'schema');
}

/**
 * Why `ref` does not lead to a schema inside the field, or `undefined` when it
 * does. TypeBox resolves a `#` reference against the nearest schema with an
 * `$id` and any other against the whole field; this asks the same resolver.
 */
function referenceProblem(
	field: object,
	scope: object,
	ref: string,
): string | undefined {
	// A reference that is not a URI resolves to nothing.
	const { data: target } = trySync({
		try: () =>
			Resolve.Ref(
				(ref.startsWith('#') ? scope : field) as Parameters<
					typeof Resolve.Ref
				>[0],
				ref,
			),
		catch: () => Ok(undefined),
	});
	if (target === undefined) return 'which nothing in this field defines';
	if (typeof target !== 'boolean' && !isPlainObject(target))
		return 'which is not a schema';
	return undefined;
}

/**
 * The field a declaration's schema prepares to: its JSON, deeply frozen, so
 * what is validated in memory is exactly what a file holds. TypeBox's hidden
 * keywords are dropped, except that an optional field keeps `~optional`, the
 * one marker `isOptional` reads, hidden as TypeBox keeps it.
 */
function plainSchema(declared: object, optional: boolean): TSchema & object {
	const plain = JSON.parse(JSON.stringify(declared)) as TSchema & object;
	if (optional)
		Object.defineProperty(plain, '~optional', {
			value: true,
			enumerable: false,
		});
	const pending: unknown[] = [plain];
	while (pending.length > 0) {
		const value = pending.pop();
		if (typeof value !== 'object' || value === null) continue;
		Object.freeze(value);
		pending.push(...Object.values(value));
	}
	return plain;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * The pointer TypeBox reported, when it names a location inside `value`.
 * `undefined` for the value itself and for a path that cannot be walked.
 */
function verifiedPointer(
	value: unknown,
	instancePath: string,
): string | undefined {
	if (!instancePath.startsWith('/')) return undefined;
	let node = value;
	for (const segment of instancePath.slice(1).split('/')) {
		if (Array.isArray(node)) {
			if (!/^(0|[1-9][0-9]*)$/.test(segment) || Number(segment) >= node.length)
				return undefined;
			node = node[Number(segment)];
		} else if (typeof node === 'object' && node !== null) {
			// An unescaped key holding `/` or `~` could split into these segments.
			if (
				!Object.hasOwn(node, segment) ||
				Object.keys(node).some((key) => /[/~]/.test(key))
			)
				return undefined;
			node = (node as Record<string, unknown>)[segment];
		} else return undefined;
	}
	return instancePath;
}
