import {
	compile,
	type Kind,
	REFERENCE_KEYWORD,
	recognize,
	storageOf,
} from '@epicenter/field';
import {
	isAdmissibleCellValue,
	RECORD_SYNC_ADMISSION_LIMITS,
} from '@epicenter/record-sync';
import {
	type Static,
	type TNull,
	type TObject,
	type TSchema,
	type TUnion,
	Type,
} from 'typebox';
import { isKvDefinition } from '../document/define-kv.js';
import type { KvDefinitions } from '../document/kv.js';
import { assertSafeSegment } from '../shared/safe-segment.js';
import { sha256Hex } from '../shared/sha256.js';
import type { DocumentFormat } from './document-format.js';
import { createDocumentGuidIdentity } from './document-guid.js';
import {
	type BlobField,
	type DocumentField,
	documentFormatOf,
	isBlobField,
	isDocumentField,
	type WorkspaceField,
} from './field.js';
import {
	canonicalJson,
	createRecordsDescriptor,
	recordsSchemaHashOf,
} from './schema-descriptor.js';
import {
	deriveWorkspaceId,
	parseWorkspaceVersionLock,
	type WorkspaceVersionLockEntry,
} from './workspace-version.js';

// The preference plane shares one declaration vocabulary across storage
// planes: `defineKv` lives with the document KV implementation, and this
// subpath re-exports it so sqlite-path consumers keep one import site.
// KV schemas may be `nullable(...)`: the preference plane never rides the
// record wire, so null is an ordinary stored value, not a clear signal.
export { defineKv } from '../document/define-kv.js';
export type { KvDefinition, KvDefinitions } from '../document/kv.js';

export type Fields = Record<string, WorkspaceField>;
type TableFields = Fields & { id: TSchema };
type DocumentFormats = Record<string, DocumentFormat>;

type CellFields<TFields extends TableFields> = {
	readonly [TName in keyof TFields as TFields[TName] extends DocumentField
		? never
		: TName]: TFields[TName] extends TSchema ? TFields[TName] : never;
};

type Documents<TFields extends TableFields> = {
	readonly [TName in keyof TFields as TFields[TName] extends DocumentField
		? TName
		: never]: TFields[TName] extends DocumentField<infer TFormat>
		? TFormat
		: never;
};

type BlobFields<TFields extends TableFields> = {
	readonly [TName in keyof TFields as TFields[TName] extends BlobField
		? TName
		: never]: TFields[TName] extends BlobField ? TFields[TName] : never;
};

export type CompiledColumn = {
	readonly name: string;
	readonly kind: Kind;
	readonly storage: ReturnType<typeof storageOf>;
	readonly isNullable: boolean;
	readonly referenceTable: string | null;
	check(value: unknown): boolean;
};

declare const tableDefinitionBrand: unique symbol;
const tableDefinitions = new WeakSet<object>();

export type TableDefinition<
	TFields extends TableFields = TableFields,
	TColumns extends CellFields<TFields> = CellFields<TFields>,
	TDocuments extends DocumentFormats = DocumentFormats,
> = {
	readonly fields: Readonly<TFields>;
	readonly columns: Readonly<TColumns>;
	readonly schema: TObject<TColumns>;
	readonly documents: Readonly<TDocuments>;
	readonly blobs: Readonly<BlobFields<TFields>>;
	readonly compiledColumns: Readonly<{
		[TName in keyof TColumns]: CompiledColumn;
	}>;
	readonly [tableDefinitionBrand]: true;
};

export type RowFor<TDefinition extends { schema: TSchema }> = Static<
	TDefinition['schema']
> & { id: string };

type NullableFieldError =
	'Fields that admit null must be explicitly wrapped in nullable(...)​';

type ConstrainNullAxis<TSchemaValue extends TSchema> =
	null extends Static<TSchemaValue>
		? TSchemaValue extends TUnion<[TSchema, TNull]>
			? TSchemaValue
			: NullableFieldError
		: TSchemaValue;

type ConstrainTableFields<TFields extends TableFields> = {
	[TName in keyof TFields]: TFields[TName] extends DocumentField
		? TFields[TName]
		: TFields[TName] extends TSchema
			? ConstrainNullAxis<TFields[TName]>
			: never;
};

export function defineTable<const TFields extends TableFields>(config: {
	fields: ConstrainTableFields<TFields>;
}): TableDefinition<TFields, CellFields<TFields>, Documents<TFields>> {
	const authoredFields = config.fields as TFields;
	assertSchemaRecord(authoredFields, 'table fields', 'table field');
	const authoredColumns: Record<string, TSchema> = {};
	const authoredDocuments: Record<string, DocumentFormat> = {};
	const authoredBlobs: Record<string, BlobField> = {};
	for (const [name, declaration] of Object.entries(authoredFields)) {
		if (isDocumentField(declaration)) {
			assertSafeSegment(name, 'child document field name');
			authoredDocuments[name] = documentFormatOf(declaration);
			continue;
		}
		authoredColumns[name] = declaration;
		if (isBlobField(declaration)) authoredBlobs[name] = declaration;
	}
	if (!Object.hasOwn(authoredColumns, 'id')) {
		throw new Error("Table field 'id' must be a persisted cell");
	}
	const ownedColumns = Object.freeze(
		Object.fromEntries(
			Object.entries(authoredColumns).map(([name, schema]) => [
				name,
				snapshotSchema(schema),
			]),
		),
	) as CellFields<TFields>;
	const compiledColumns = Object.fromEntries(
		Object.entries(ownedColumns as Record<string, TSchema>).map(
			([name, schema]) => [name, Object.freeze(compileColumn(name, schema))],
		),
	) as { [TName in keyof CellFields<TFields>]: CompiledColumn };
	Object.freeze(compiledColumns);

	const id = (compiledColumns as Record<string, CompiledColumn>).id;
	if (!id || id.kind !== 'string' || id.isNullable) {
		throw new Error(
			"Table column 'id' must be a non-null field.string() schema",
		);
	}

	// Fail at definition time instead of a cryptic runtime parseMutation
	// refusal: every non-id column becomes one wire cell, so the declared
	// shape must fit the record admission ceilings in every mode.
	const cellColumnCount = Object.keys(ownedColumns).length - 1;
	if (cellColumnCount > RECORD_SYNC_ADMISSION_LIMITS.cellsPerOperation) {
		throw new Error(
			`Table declares ${cellColumnCount} cell columns; the record protocol admits at most ${RECORD_SYNC_ADMISSION_LIMITS.cellsPerOperation} cells per operation`,
		);
	}
	const encoder = new TextEncoder();
	for (const name of Object.keys(ownedColumns)) {
		if (
			encoder.encode(name).byteLength >
			RECORD_SYNC_ADMISSION_LIMITS.identifierBytes
		) {
			throw new Error(
				`Table column '${name}' exceeds the ${RECORD_SYNC_ADMISSION_LIMITS.identifierBytes}-byte wire identifier ceiling`,
			);
		}
	}

	const ownedDocuments = Object.freeze({
		...authoredDocuments,
	}) as Documents<TFields>;
	const ownedBlobs = Object.freeze({ ...authoredBlobs }) as BlobFields<TFields>;
	const ownedFields = Object.freeze(
		Object.fromEntries(
			Object.entries(authoredFields).map(([name, declaration]) => [
				name,
				isDocumentField(declaration)
					? declaration
					: (ownedColumns as Record<string, TSchema>)[name],
			]),
		),
	) as TFields;

	const definition = Object.freeze({
		fields: ownedFields,
		columns: ownedColumns,
		schema: freezeOwnedJson(
			Type.Object(ownedColumns, { additionalProperties: false }),
		),
		documents: ownedDocuments,
		blobs: ownedBlobs,
		compiledColumns,
	}) as unknown as TableDefinition<
		TFields,
		CellFields<TFields>,
		Documents<TFields>
	>;
	tableDefinitions.add(definition);
	return definition;
}

export type TableDefinitions = Record<string, TableDefinition>;

const workspaceCandidateBrand: unique symbol = Symbol(
	'epicenter.workspace-candidate',
);
const workspaceDefinitionBrand: unique symbol = Symbol(
	'epicenter.workspace-definition',
);
const workspaceCandidates = new WeakSet<object>();
const workspaceDefinitions = new WeakSet<object>();

type WorkspaceSource<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
> = {
	readonly appId: string;
	readonly version: number;
	readonly workspaceId: string;
	readonly recordsDescriptor: string;
	readonly recordsSchemaHash: string;
	/** Display label only (mount labels, sign-in copy). Defaults to `appId`. */
	readonly name: string;
	readonly tables: Readonly<TTables>;
	readonly kv: Readonly<TKv>;
	/** Eager preference-document guid: `<workspaceId>.kv` (ADR-0124). */
	readonly kvDocumentGuid: string;
	readonly proposedLockEntry: WorkspaceVersionLockEntry;
};

export type WorkspaceCandidate<
	TTables extends TableDefinitions = TableDefinitions,
	TKv extends KvDefinitions = KvDefinitions,
> = WorkspaceSource<TTables, TKv> & {
	readonly [workspaceCandidateBrand]: true;
};

export type WorkspaceDefinition<
	TTables extends TableDefinitions = TableDefinitions,
	TKv extends KvDefinitions = KvDefinitions,
> = WorkspaceSource<TTables, TKv> & {
	readonly [workspaceDefinitionBrand]: true;
};

/**
 * Declare one immutable application data contract before validating its lock.
 *
 * `version` changes only when the durable table, KV, document, or blob contract
 * breaks. Ordinary software releases keep the same version. One `appId` and
 * version pair resolves one forward-moving workspace per principal; append the
 * candidate to `workspace-version-lock.json` before opening storage.
 *
 * @example
 * ```ts
 * const candidate = defineWorkspace({
 *   appId: 'whispering',
 *   version: 2,
 *   tables: { recordings },
 * });
 * ```
 */
export function defineWorkspace<
	const TTables extends TableDefinitions,
	const TKv extends KvDefinitions = Record<never, never>,
>({
	appId,
	version,
	name,
	tables,
	kv,
}: {
	appId: string;
	version: number;
	name?: string;
	tables: TTables;
	kv?: TKv;
}): WorkspaceCandidate<TTables, TKv> {
	const workspaceId = deriveWorkspaceId(appId, version);
	const displayName = name ?? appId;
	if (displayName.trim() === '') {
		throw new Error('Workspace name must not be empty');
	}
	assertSchemaRecord(tables, 'workspace tables', 'workspace table');
	const ownedTables = Object.freeze({ ...tables }) as TTables;

	for (const [tableName, table] of Object.entries(ownedTables)) {
		if (!tableDefinitions.has(table)) {
			throw new Error(`Workspace table '${tableName}' must use defineTable()`);
		}
		if (Object.keys(table.documents).length > 0) {
			assertSafeSegment(tableName, 'child document table name');
		}
		for (const column of Object.values(table.compiledColumns)) {
			if (
				column.referenceTable !== null &&
				!Object.hasOwn(ownedTables, column.referenceTable)
			) {
				throw new Error(
					`Table '${tableName}' column '${column.name}' references unknown table '${column.referenceTable}'`,
				);
			}
		}
	}

	const declaredKv = (kv ?? {}) as TKv;
	assertSchemaRecord(declaredKv, 'workspace KV', 'workspace KV key');
	for (const [key, definition] of Object.entries(declaredKv)) {
		if (key === '') throw new Error('Workspace KV key must not be empty');
		if (!isKvDefinition(definition)) {
			throw new Error(`Workspace KV key '${key}' must use defineKv()`);
		}
	}
	const ownedKv = Object.freeze({ ...declaredKv }) as TKv;
	// KV, documents, and display name are deliberately absent.
	// They have independent identities or are runtime behavior, not accepted
	// SQLite record state.
	const recordsDescriptor = createRecordsDescriptor(
		Object.entries(ownedTables).map(([tableName, table]) => ({
			name: tableName,
			fields: Object.fromEntries(
				Object.entries(table.columns).map(([columnName, schema]) => [
					columnName,
					toAtRestSchema(schema),
				]),
			),
		})),
	);
	const recordsSchemaHash = recordsSchemaHashOf(recordsDescriptor);
	const planeEntries: Array<[string, string]> = [
		['kv', `${workspaceId}.kv`],
		...Object.entries(ownedKv).map(([key, definition]): [string, string] => [
			`kv.${key}`,
			`sha256:${sha256Hex(canonicalJson(definition.schema))}`,
		]),
		...Object.entries(ownedTables).flatMap(([tableName, table]) =>
			Object.entries(table.documents).map(
				([documentName, format]): [string, string] => {
					const identity = createDocumentGuidIdentity({
						workspaceId,
						table: tableName,
						document: documentName,
						format,
					});
					return [`document.${tableName}.${documentName}`, identity.lockToken];
				},
			),
		),
	];
	const planes = Object.freeze(
		Object.fromEntries(
			planeEntries.sort(([left], [right]) =>
				left < right ? -1 : left > right ? 1 : 0,
			),
		),
	);
	const proposedLockEntry = Object.freeze({
		version,
		workspaceId,
		tablesSchemaHash: recordsSchemaHash,
		planes,
	});

	const candidate = Object.freeze({
		appId,
		version,
		workspaceId,
		name: displayName,
		tables: ownedTables,
		kv: ownedKv,
		kvDocumentGuid: `${workspaceId}.kv`,
		recordsDescriptor,
		recordsSchemaHash,
		proposedLockEntry,
		[workspaceCandidateBrand]: true as const,
	});
	workspaceCandidates.add(candidate);
	return candidate;
}

export type WorkspaceCandidateInspection = Readonly<
	Pick<
		WorkspaceSource<TableDefinitions, KvDefinitions>,
		'appId' | 'proposedLockEntry'
	>
>;

/** Inspect only a candidate minted by defineWorkspace(). */
export function inspectWorkspaceCandidate(
	value: unknown,
): WorkspaceCandidateInspection {
	if (
		typeof value !== 'object' ||
		value === null ||
		!workspaceCandidates.has(value)
	) {
		throw new Error(
			'Workspace candidate must be returned by defineWorkspace()',
		);
	}
	const candidate = value as WorkspaceCandidate;
	return Object.freeze({
		appId: candidate.appId,
		proposedLockEntry: candidate.proposedLockEntry,
	});
}

/** @internal Reject definitions not minted by lockWorkspace(). */
export function assertWorkspaceDefinition(
	value: unknown,
): asserts value is WorkspaceDefinition {
	if (
		typeof value !== 'object' ||
		value === null ||
		!workspaceDefinitions.has(value)
	) {
		throw new Error('Workspace definition must be returned by lockWorkspace()');
	}
}

/** Validate the committed lock and authorize this declared version at runtime. */
export function lockWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
>(
	candidate: WorkspaceCandidate<TTables, TKv>,
	lockValue: unknown,
): WorkspaceDefinition<TTables, TKv> {
	inspectWorkspaceCandidate(candidate);
	const lock = parseWorkspaceVersionLock(lockValue);
	if (lock.appId !== candidate.appId) {
		throw new Error(
			`Workspace version lock belongs to '${lock.appId}', not '${candidate.appId}'`,
		);
	}
	const published = lock.versions.find(
		(entry) => entry.version === candidate.version,
	);
	if (
		published === undefined ||
		canonicalJson(published) !== canonicalJson(candidate.proposedLockEntry)
	) {
		throw new Error(
			`Workspace version lock does not publish version ${candidate.version}`,
		);
	}
	const definition = Object.freeze({
		...candidate,
		[workspaceDefinitionBrand]: true as const,
	});
	workspaceDefinitions.add(definition);
	return definition;
}

function assertSchemaRecord(
	record: object,
	containerLabel: string,
	keyLabel: string,
): void {
	const prototype = Object.getPrototypeOf(record);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Error(`${containerLabel} must be a plain record`);
	}
	for (const key of Object.keys(record)) {
		if (Object.hasOwn(Object.prototype, key)) {
			throw new Error(`${keyLabel} '${key}' collides with Object.prototype`);
		}
	}
}

function compileColumn(name: string, authoredSchema: TSchema): CompiledColumn {
	const schema = toAtRestSchema(authoredSchema);
	const nullableInner = readNullableInner(schema);
	const recognized = recognize(nullableInner ?? schema);
	if (recognized === null) {
		throw new Error(
			`Persisted field '${name}' must use field.*${nullableInner === null ? ' or nullable(field.*)' : ''}`,
		);
	}

	const checkInner = compile(recognized.schema);
	if (nullableInner === null && checkInner(null)) {
		throw new Error(
			`Persisted field '${name}' admits null and must be explicitly wrapped in nullable(...)`,
		);
	}
	const isNullable = nullableInner !== null;
	if (
		'maxBytes' in recognized.schema &&
		recognized.schema.maxBytes !== undefined &&
		recognized.schema.maxBytes > RECORD_SYNC_ADMISSION_LIMITS.encodedCellBytes
	) {
		throw new Error(
			`Persisted field '${name}' maxBytes exceeds the ${RECORD_SYNC_ADMISSION_LIMITS.encodedCellBytes}-byte synchronization ceiling`,
		);
	}
	return {
		name,
		kind: recognized.kind,
		storage: storageOf(recognized.kind),
		isNullable,
		referenceTable:
			recognized.kind === 'reference'
				? recognized.schema[REFERENCE_KEYWORD]
				: null,
		check(value) {
			if (!isJsonValue(value) || !isAdmissibleCellValue(value)) return false;
			if (value === null && nullableInner !== null) return true;
			return checkInner(value);
		},
	};
}

function toAtRestSchema(schema: TSchema): unknown {
	try {
		return JSON.parse(JSON.stringify(schema));
	} catch (cause) {
		throw new Error('Persisted field schema must be JSON serializable', {
			cause,
		});
	}
}

function snapshotSchema<TSchemaValue extends TSchema>(
	schema: TSchemaValue,
): TSchemaValue {
	return freezeOwnedJson(toAtRestSchema(schema)) as TSchemaValue;
}

function freezeOwnedJson<TValue>(value: TValue): TValue {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
		return value;
	}
	for (const child of Object.values(value)) freezeOwnedJson(child);
	return Object.freeze(value);
}

function readNullableInner(schema: unknown): unknown | null {
	if (!isRecord(schema)) return null;
	const anyOf = schema.anyOf;
	if (!Array.isArray(anyOf) || anyOf.length !== 2) return null;

	const nullIndex = anyOf.findIndex(isNullSchema);
	if (nullIndex === -1) return null;
	return anyOf[nullIndex === 0 ? 1 : 0];
}

function isNullSchema(value: unknown): boolean {
	return (
		isRecord(value) && Object.keys(value).length === 1 && value.type === 'null'
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean'
	) {
		return true;
	}
	if (typeof value === 'number') return Number.isFinite(value);
	if (typeof value !== 'object') return false;

	if (ancestors.has(value)) return false;
	ancestors.add(value);
	const isJson = Array.isArray(value)
		? value.every((item) => isJsonValue(item, ancestors))
		: (Object.getPrototypeOf(value) === Object.prototype ||
				Object.getPrototypeOf(value) === null) &&
			Object.values(value).every((item) => isJsonValue(item, ancestors));
	ancestors.delete(value);
	return isJson;
}
