/**
 * SQLite Child-Document Guid Tests
 *
 * Proves record ids are collision-resistant address inputs rather than raw
 * filesystem segments, while authored namespace segments remain validated.
 */

import { expect, test } from 'bun:test';
import { sha256Hex } from '../shared/sha256.js';
import { document, inspectDocumentFormat } from './document-format.js';
import { createDocumentGuidIdentity } from './document-guid.js';

test('the lock token contains the exact runtime hash domain and guid grammar', () => {
	const identity = createDocumentGuidIdentity({
		workspaceId: 'notes-v2',
		table: 'entries',
		document: 'body',
		format: document.plainText,
	});
	const rowId = 'Imported/Row.日本語';
	const rowDigest = sha256Hex(
		`epicenter.document-row/1\0${JSON.stringify(rowId)}`,
	);
	const formatDigest = inspectDocumentFormat(
		document.plainText,
	).formatHash.slice('sha256:'.length);
	const contract =
		`epicenter.sqlite-child-document-guid/1;row-id=epicenter.document-row/1;guid=` +
		`notes-v2.entries.<row-id-sha256>.body.${formatDigest}`;

	expect(identity.lockToken).toBe(contract);
	expect(String(identity.guid(rowId))).toBe(
		contract
			.slice(contract.indexOf('guid=') + 'guid='.length)
			.replace('<row-id-sha256>', rowDigest),
	);
});

test('every record id string derives one fixed safe address segment', () => {
	const rowId = 'Imported/Row.日本語';
	const identity = createDocumentGuidIdentity({
		workspaceId: 'notes',
		table: 'entries',
		document: 'body',
		format: document.plainText,
	});
	const guid = identity.guid(rowId);
	const rowDigest = sha256Hex(
		`epicenter.document-row/1\0${JSON.stringify(rowId)}`,
	);
	const formatDigest = inspectDocumentFormat(
		document.plainText,
	).formatHash.slice('sha256:'.length);

	expect(String(guid)).toBe(`notes.entries.${rowDigest}.body.${formatDigest}`);
	expect(guid).not.toContain(rowId);
});

test('distinct record ids derive distinct rooms', () => {
	const identity = createDocumentGuidIdentity({
		workspaceId: 'notes',
		table: 'entries',
		document: 'body',
		format: document.plainText,
	});

	expect(identity.guid('case-sensitive')).not.toBe(
		identity.guid('Case-Sensitive'),
	);
	expect(identity.guid('')).toContain(
		sha256Hex(`epicenter.document-row/1\0${JSON.stringify('')}`),
	);
});

test('distinct lone UTF-16 surrogates remain distinct hash inputs', () => {
	const identity = createDocumentGuidIdentity({
		workspaceId: 'notes',
		table: 'entries',
		document: 'body',
		format: document.plainText,
	});

	expect(identity.guid('\ud800')).not.toBe(identity.guid('\ud801'));
	expect(identity.guid('\ud800')).not.toBe(identity.guid('\ufffd'));
	expect(identity.guid('😀')).toContain(
		sha256Hex(`epicenter.document-row/1\0${JSON.stringify('😀')}`),
	);
});
