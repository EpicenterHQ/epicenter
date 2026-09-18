/**
 * Turning a first-party declaration into the compiled form the store reads.
 *
 * The runtime half of the rules `define.ts` states at the authoring call.
 * Definitions arrive from trusted TypeScript modules, not serialized JSON.
 *
 * Nothing an application writes points at this file. It is the boundary
 * between what was declared and what the engine holds.
 */

import type { TSchema } from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result, trySync } from 'wellcrafted/result';
import {
	compile as compileField,
	type Field,
	recognize,
	referenceTargetOf,
} from '../field/index.js';

import { DATA_ADDRESS_CEILINGS, isDataId, isTableName } from './addresses.js';
import {
	CONTENT_FIELD,
	type ContentCodec,
	type DataDefinition,
	type DataField,
	KV_ROOT,
	RESERVED_ATTRIBUTE_PREFIX,
	RESERVED_TABLE_NAMES,
	type TableDeclaration,
} from './declaration.js';
import type { JsonObject, JsonValue } from './json.js';

export type ConformanceIssue = { field: string; message: string };

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
		message: `Field '${table}.${field}' is not recognized vocabulary: ${reason}`,
		table,
		field,
		reason,
	}),
	DeclarationDefault: ({ table, field }: { table: string; field: string }) => ({
		message: `Field '${table}.${field}' declares a default; initialization and recovery belong to the application`,
		table,
		field,
	}),
});
export type DataDefinitionParseError = InferErrors<
	typeof DataDefinitionParseError
>;

export type Conformance = {
	conforming: JsonObject;
	issues: ConformanceIssue[];
};

export type ParsedTable = {
	name: string;
	/**
	 * The value fields, compiled. The content node is NOT here: it holds no
	 * JSON value, so it has no schema to check a payload against and nothing a
	 * conformance read could report.
	 */
	fields: ReadonlyMap<string, DataField>;
	/**
	 * How this table's content node becomes text, carried unread (ADR-0296).
	 *
	 * Absent when the table declares no codec. The artifact boundary refuses
	 * populated nodes on export and nonempty bodies on import.
	 */
	content?: ContentCodec;
	conformance(payload: JsonObject): Conformance;
};

export type ParsedDataDefinition = {
	id: string;
	title?: string;
	kv: ParsedTable;
	tables: ReadonlyMap<string, ParsedTable>;
};

const parsed = new WeakMap<
	object,
	Result<ParsedDataDefinition, DataDefinitionParseError>
>();

/**
 * Parse and compile one definition, held beside the definition object (ADR-0266).
 *
 * Keyed on object identity, not a content hash. The memo is what makes eager
 * validation free: `defineApp` compiles at the authoring call so a malformed
 * definition fails there rather than at first open (ADR-0266), and without this
 * every opener would redo that work. It is not here for the milliseconds; it is
 * here so "validate early" does not mean "validate twice".
 *
 * Identity keying means a definition MUTATED IN PLACE would read back its old
 * compile. Definitions are module-level constants built from `field.*` and are
 * never mutated.
 */
export function compileData(
	value: DataDefinition,
): Result<ParsedDataDefinition, DataDefinitionParseError> {
	const memoised = parsed.get(value);
	if (memoised !== undefined) return memoised;
	const result = compileDefinition(value);
	parsed.set(value, result);
	return result;
}

function compileDefinition(
	value: unknown,
): Result<ParsedDataDefinition, DataDefinitionParseError> {
	if (!isPlainObject(value))
		return DataDefinitionParseError.Malformed({
			reason: 'it is not a plain object',
		});
	const { id, title, kv, tables } = value as Partial<DataDefinition>;
	if (typeof id !== 'string' || !isDataId(id, DATA_ADDRESS_CEILINGS)) {
		return DataDefinitionParseError.Malformed({
			reason: 'it declares an invalid id',
		});
	}
	if (
		title !== undefined &&
		(typeof title !== 'string' || title.trim() === '')
	) {
		return DataDefinitionParseError.Malformed({
			reason: 'its title must say something or be absent',
		});
	}
	if (!isPlainObject(kv))
		return DataDefinitionParseError.Malformed({
			reason: 'it declares no kv section',
		});
	if (!isPlainObject(tables))
		return DataDefinitionParseError.Malformed({
			reason: 'it declares no tables',
		});

	const compiledKvResult = compileTable(KV_ROOT, kv);
	if (compiledKvResult.error !== null) return compiledKvResult;
	const compiledKv = compiledKvResult.data;
	const compiledTables = new Map<string, ParsedTable>();
	const foldedNames = new Map<string, string>();
	for (const [tableName, declaration] of Object.entries(tables)) {
		if (
			!isTableName(tableName, DATA_ADDRESS_CEILINGS) ||
			RESERVED_TABLE_NAMES.includes(tableName)
		) {
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
		foldedNames.set(folded, tableName);
		if (!isPlainObject(declaration)) {
			return DataDefinitionParseError.Malformed({
				reason: `table '${tableName}' must declare a flat field map`,
			});
		}
		const table = declaration as TableDeclaration;
		if (CONTENT_FIELD in table && !isContentCodec(table.content)) {
			return DataDefinitionParseError.Malformed({
				reason: `table '${tableName}' declares an invalid content codec`,
			});
		}
		const result = compileTable(tableName, table);
		if (result.error !== null) return result;
		compiledTables.set(tableName, {
			...result.data,
			content: table.content,
		});
	}
	return Ok(
		Object.freeze({
			id,
			...(title === undefined ? {} : { title }),
			kv: compiledKv,
			tables: compiledTables,
		}),
	);
}

function compileTable(
	tableName: string,
	declaration: unknown,
): Result<ParsedTable, DataDefinitionParseError> {
	if (!isPlainObject(declaration))
		return DataDefinitionParseError.Malformed({
			reason: `table '${tableName}' does not declare a flat field map`,
		});
	const compiled = new Map<string, DataField>();
	for (const [fieldName, descriptor] of Object.entries(declaration)) {
		// A table's `content` is the codec for its rows' live node, not a field,
		// so it never compiles as one. On a ROW and only there: kv holds settings
		// rather than rows, so it has no node, and a setting a person happens to
		// call `content` is an ordinary field. Skipping it for kv too would drop
		// the key at compile and leave `kv.get` answering `undefined` for a value
		// the document is holding, with `nonconforming` reporting nothing.
		if (tableName !== KV_ROOT && fieldName === CONTENT_FIELD) continue;
		const invalid = fieldNameProblem(tableName, fieldName);
		if (invalid !== undefined) return invalid;
		if (!isPlainObject(descriptor)) {
			return DataDefinitionParseError.UnrecognizedField({
				table: tableName,
				field: fieldName,
				reason: 'a field descriptor must be a JSON object',
			});
		}
		if (containsDefault(descriptor)) {
			return DataDefinitionParseError.DeclarationDefault({
				table: tableName,
				field: fieldName,
			});
		}
		const serialized = trySync({
			try: () =>
				JSON.parse(
					JSON.stringify(descriptor, (_key, value: unknown) => {
						if (
							(typeof value === 'number' && !Number.isFinite(value)) ||
							typeof value === 'bigint' ||
							typeof value === 'symbol'
						) {
							throw new TypeError(
								'Field descriptors require finite JSON values',
							);
						}
						return value;
					}),
				) as Record<string, unknown>,
			catch: (cause) =>
				DataDefinitionParseError.Malformed({ reason: String(cause) }),
		});
		if (serialized.error !== null) return serialized;
		const wire = serialized.data;
		const nullableDescriptor = nullableParts(wire);
		const base = recognize(nullableDescriptor?.inner ?? wire);
		if (base === null) {
			return DataDefinitionParseError.UnrecognizedField({
				table: tableName,
				field: fieldName,
				reason: 'expected a closed @epicenter/app/field descriptor',
			});
		}
		const check = compileField(base.schema);
		compiled.set(fieldName, {
			name: fieldName,
			kind: base.kind,
			schema: wire,
			check:
				nullableDescriptor === null
					? check
					: (value) => value === null || check(value),
			nullable: nullableDescriptor !== null,
			reference: referenceTargetOf({
				...base,
				name: fieldName,
				check,
			} as Field),
		});
	}
	return Ok(
		Object.freeze({
			name: tableName,
			fields: compiled,
			conformance(payload: JsonObject): Conformance {
				const conforming: JsonObject = {};
				const issues: ConformanceIssue[] = [];
				for (const [fieldName, field] of compiled) {
					if (!Object.hasOwn(payload, fieldName)) {
						issues.push({
							field: fieldName,
							message: `${fieldName} is missing`,
						});
					} else if (!field.check(payload[fieldName])) {
						issues.push({
							field: fieldName,
							message: `${fieldName} is not a conforming ${field.kind} value`,
						});
					} else {
						conforming[fieldName] = payload[fieldName] as JsonValue;
					}
				}
				return { conforming, issues };
			},
		}),
	);
}

function nullableParts(
	value: Record<string, unknown>,
): { inner: TSchema } | null {
	if (!Array.isArray(value.anyOf) || value.anyOf.length !== 2) return null;
	const nonNull = value.anyOf.filter((part) => !isNullSchema(part));
	return nonNull.length === 1 && isPlainObject(nonNull[0])
		? { inner: nonNull[0] }
		: null;
}

function isNullSchema(value: unknown): boolean {
	return (
		isPlainObject(value) &&
		value.type === 'null' &&
		Object.keys(value).every((key) => key === 'type')
	);
}

function containsDefault(value: unknown, seen = new Set<object>()): boolean {
	if (!isPlainObject(value) && !Array.isArray(value)) return false;
	if (typeof value === 'object' && value !== null) {
		if (seen.has(value)) return false;
		seen.add(value);
	}
	if (isPlainObject(value) && Object.hasOwn(value, 'default')) return true;
	return Object.values(value).some((child) => containsDefault(child, seen));
}

function fieldNameProblem(
	tableName: string,
	fieldName: string,
): Result<never, DataDefinitionParseError> | undefined {
	if (
		fieldName.startsWith(RESERVED_ATTRIBUTE_PREFIX) ||
		fieldName.toLowerCase() === 'id' ||
		!/^[A-Za-z][A-Za-z0-9_]*$/.test(fieldName)
	) {
		return DataDefinitionParseError.Malformed({
			reason: `field name '${tableName}.${fieldName}' is not usable`,
		});
	}
	return undefined;
}

/**
 * All three verbs, because a partial codec is a runtime failure rather than a
 * degraded one.
 *
 * `rewrite` is checked here for the same reason `decode` is: a push calls it
 * on a body a person answered for, inside the transaction that carries the
 * whole plan, and a missing one would throw out of a commit that had already
 * written half of it. The authoring type demands all three; this is the door a
 * definition that did not go through it comes in by.
 */
function isContentCodec(value: unknown): value is ContentCodec {
	const codec = value as Partial<ContentCodec> | undefined;
	return (
		typeof codec?.encode === 'function' &&
		typeof codec.decode === 'function' &&
		typeof codec.rewrite === 'function'
	);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
