import type { Guid } from '../shared/id.js';
import { assertSafeSegment } from '../shared/safe-segment.js';
import { sha256Hex } from '../shared/sha256.js';
import {
	type DocumentFormat,
	inspectDocumentFormat,
} from './document-format.js';

export const DOCUMENT_GUID_LOCK_FORMAT =
	'epicenter.sqlite-child-document-guid/1' as const;
const DOCUMENT_ROW_ID_DIGEST_DOMAIN = 'epicenter.document-row/1';

export type DocumentGuidIdentity = {
	readonly workspaceId: string;
	/** Versioned durable contract recorded in the application data version lock. */
	readonly lockToken: string;
	guid(rowId: string): Guid;
};

type DocumentGuidOwner = {
	workspaceId: string;
	table: string;
	document: string;
};

/**
 * Derive one format-addressed child-document guid for the SQLite workspace path.
 *
 * The established four owner segments remain readable from the left. The final
 * digest segment fences incompatible document formats without coupling them to
 * records-epoch changes:
 *
 * `<workspace>.<table>.<row-id digest>.<document>.<format digest>`
 *
 * Record ids are application values, not storage-path segments. Hashing the
 * complete JSON string encoding gives every admissible JavaScript string one
 * collision-resistant fixed-size safe segment without narrowing the record
 * schema to a filename grammar. JSON escaping preserves distinct lone UTF-16
 * surrogates that `TextEncoder` alone would replace with the same character.
 */
export function createDocumentGuidIdentity({
	workspaceId,
	table,
	document,
	format,
}: {
	workspaceId: string;
	table: string;
	document: string;
	format: DocumentFormat;
}): DocumentGuidIdentity {
	assertSafeSegment(workspaceId, 'document workspace id');
	assertSafeSegment(table, 'document table name');
	assertSafeSegment(document, 'document name');
	const digest = inspectDocumentFormat(format).formatHash.slice(
		'sha256:'.length,
	);
	assertSafeSegment(digest, 'document format hash');
	const rowIdPlaceholder = '<row-id-sha256>';
	const addressPattern = `${workspaceId}.${table}.${rowIdPlaceholder}.${document}.${digest}`;

	return Object.freeze({
		workspaceId,
		lockToken: `${DOCUMENT_GUID_LOCK_FORMAT};row-id=${DOCUMENT_ROW_ID_DIGEST_DOMAIN};guid=${addressPattern}`,
		guid(rowId: string): Guid {
			const rowIdDigest = sha256Hex(
				`${DOCUMENT_ROW_ID_DIGEST_DOMAIN}\0${JSON.stringify(rowId)}`,
			);
			return addressPattern.replace(rowIdPlaceholder, rowIdDigest) as Guid;
		},
	});
}

/** Validate one published token without recreating the contract grammar. */
export function isDocumentGuidLockTokenFor(
	token: string,
	{ workspaceId, table, document }: DocumentGuidOwner,
): boolean {
	const prefix = `${DOCUMENT_GUID_LOCK_FORMAT};row-id=${DOCUMENT_ROW_ID_DIGEST_DOMAIN};guid=${workspaceId}.${table}.<row-id-sha256>.${document}.`;
	return (
		token.startsWith(prefix) &&
		/^[0-9a-f]{64}$/.test(token.slice(prefix.length))
	);
}
