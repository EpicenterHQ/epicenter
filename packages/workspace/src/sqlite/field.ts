import { field as cellField } from '@epicenter/field';
import { type TSchema, type TUnsafe, Type } from 'typebox';
import { ID_MAX_LENGTH, ID_PATTERN } from '../shared/id.js';
import type { DocumentFormat } from './document-format.js';

export const BLOB_REF_KEYWORD = 'x-epicenter-blob-ref' as const;
const DOCUMENT_FIELD = Symbol('epicenter.document-field');
const SHA256_HEX_PATTERN = '^[0-9a-f]{64}$';

/** Portable reference to immutable bytes stored outside SQLite. */
export type BlobRef = Readonly<{
	/** Lowercase hexadecimal SHA-256 digest of the stored bytes. */
	hash: string;
	/** Exact positive byte length reported by durable blob storage. */
	size: number;
	/** Media type stored with the object and returned by authenticated HEAD. */
	mediaType: string;
}>;

export type BlobField = TUnsafe<BlobRef> & {
	readonly [BLOB_REF_KEYWORD]: 1;
};

export type DocumentField<TFormat extends DocumentFormat = DocumentFormat> = {
	readonly [DOCUMENT_FIELD]: TFormat;
};

/** A row ID schema carrying the shared Epicenter ID envelope. */
export type IdField<TId extends string = string> = TUnsafe<TId> & {
	readonly minLength: 1;
	readonly maxLength: typeof ID_MAX_LENGTH;
	readonly pattern: typeof ID_PATTERN;
};

const documentFields = new WeakMap<object, DocumentFormat>();

/**
 * Declare an opaque, URL-safe row ID.
 *
 * Ordinary `table.create(...)` calls omit this value and receive an Epicenter
 * NanoID. Copy-forward and import code may provide an existing ID that matches
 * this same envelope, including a UUID.
 */
function id<TId extends string = string>(): IdField<TId> {
	return cellField.string<TId>({
		minLength: 1,
		maxLength: ID_MAX_LENGTH,
		pattern: ID_PATTERN,
	}) as unknown as IdField<TId>;
}

/** Declare a reference to another table's Epicenter row ID. */
function reference<TId extends string = string>(
	table: string,
	opts?: Parameters<typeof cellField.reference>[1],
) {
	return cellField.reference<TId>(table, {
		...opts,
		minLength: 1,
		maxLength: ID_MAX_LENGTH,
		pattern: ID_PATTERN,
	});
}

/**
 * Declare a SQLite cell that stores a portable reference to external bytes.
 *
 * Upload the bytes first, then publish the returned `BlobRef` in a row. Tables
 * apply rejects a reference when its size or media type disagrees with durable
 * blob storage.
 *
 * @example
 * ```ts
 * const recordings = defineTable({
 *   fields: {
 *     id: field.id(),
 *     audio: field.blob(),
 *   },
 * });
 * ```
 */
function blob(): BlobField {
	return Type.Unsafe<BlobRef>({
		...cellField.json(
			Type.Object(
				{
					hash: Type.String({ pattern: SHA256_HEX_PATTERN }),
					size: Type.Integer({ minimum: 1 }),
					mediaType: Type.String({ minLength: 1 }),
				},
				{ additionalProperties: false },
			),
		),
		[BLOB_REF_KEYWORD]: 1,
	}) as BlobField;
}

/**
 * Declare a lazy child document owned by one table row.
 *
 * This emits no SQLite column. Its stable address derives from the workspace,
 * table, complete row ID string, field name, and document format. Deleting the
 * row makes the document unreachable without promising immediate byte erasure.
 *
 * @example
 * ```ts
 * const notes = defineTable({
 *   fields: {
 *     id: field.id(),
 *     body: field.doc(document.plainText),
 *   },
 * });
 * ```
 */
function doc<const TFormat extends DocumentFormat>(
	format: TFormat,
): DocumentField<TFormat> {
	const token = Object.freeze({
		[DOCUMENT_FIELD]: format,
	}) as DocumentField<TFormat>;
	documentFields.set(token, format);
	return token;
}

/** @internal Definition-time guard for a schema-directed blob column. */
export function isBlobField(value: unknown): value is BlobField {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as Record<string, unknown>)[BLOB_REF_KEYWORD] === 1
	);
}

/** @internal Definition-time guard for a declared child document. */
export function isDocumentField(value: unknown): value is DocumentField {
	return (
		typeof value === 'object' && value !== null && documentFields.has(value)
	);
}

/** @internal Recover the format from a field.doc() token. */
export function documentFormatOf<TFormat extends DocumentFormat>(
	value: DocumentField<TFormat>,
): TFormat {
	const format = documentFields.get(value);
	if (!format) throw new Error('Unknown document field');
	return format as TFormat;
}

/** Composed field catalog for every value a SQLite workspace table can own. */
export const field = Object.freeze({
	...cellField,
	id,
	reference,
	blob,
	doc,
});

export type WorkspaceField = TSchema | DocumentField;
