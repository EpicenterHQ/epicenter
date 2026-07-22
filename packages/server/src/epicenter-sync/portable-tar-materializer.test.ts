/**
 * Portable TAR Materializer Tests
 *
 * Verifies the Bun materializer's canonical streaming archive contract at its
 * injected internal HTTP boundary.
 *
 * Key behaviors:
 * - Exported logical records and blobs round-trip through one canonical TAR
 * - Imports refuse malformed headers, alternate entry types, and wrong order
 * - Imports refuse duplicate, extra, corrupt, or missing blob membership
 * - Failed imports delete unpublished state and clean temporary files
 */
import { expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { blobFileOwner } from '@epicenter/data/blob-v1';
import type { PortableArtifactRecord } from '@epicenter/data/portable';
import {
	decodePortableMaterializerRecordFrame,
	decodePortableMaterializerRecordStream,
	encodePortableMaterializerRecordFrame,
} from './portable-record-stream-v1.js';
import {
	createPortableTarMaterializer,
	PORTABLE_MATERIALIZER_ADDRESS_HEADERS,
	PORTABLE_MATERIALIZER_PATHS,
	PORTABLE_SQLITE_INDEX_MAX_BYTES,
	type PortableMaterializerFetcher,
} from './portable-tar-materializer.js';

const FIRST_BYTES = new TextEncoder().encode('first portable blob');
const SECOND_BYTES = new TextEncoder().encode('second portable blob');

function sha256(bytes: Uint8Array): string {
	return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

const FIRST: PortableArtifactRecord = {
	address: {
		namespace: 'so.epicenter.notes',
		collection: 'notes',
		recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
	},
	scalar: { state: 'live', payload: { title: 'First' } },
	documentUpdateV2: null,
	blobSha256: sha256(FIRST_BYTES),
};

const SECOND: PortableArtifactRecord = {
	address: {
		namespace: 'so.epicenter.notes',
		collection: 'notes',
		recordKey: 'bbbbbbbbbbbbbbbbbbbbbbbb',
	},
	scalar: { state: 'unset' },
	documentUpdateV2: null,
	blobSha256: sha256(SECOND_BYTES),
};

type ImportCapture = {
	begun?: { recordCount: number };
	records: PortableArtifactRecord[];
	blobs: Map<string, Uint8Array>;
	sealed: boolean;
	deleted: boolean;
};

function bytesResponse(bytes: Uint8Array): Response {
	return new Response(new Blob([Uint8Array.from(bytes)]), {
		headers: { 'content-length': String(bytes.byteLength) },
	});
}

function setup(records: PortableArtifactRecord[] = [FIRST, SECOND]) {
	const blobBytes = new Map<string, Uint8Array>();
	for (const [record, bytes] of [
		[FIRST, FIRST_BYTES],
		[SECOND, SECOND_BYTES],
	] as const) {
		if (records.includes(record) && record.blobSha256 !== null) {
			const owner = blobFileOwner(record.address, record.blobSha256);
			blobBytes.set(`${owner.ownerKey}/${owner.digest}`, bytes);
		}
	}
	const capture: ImportCapture = {
		records: [],
		blobs: new Map(),
		sealed: false,
		deleted: false,
	};
	const fetcher: PortableMaterializerFetcher = {
		async fetch(request) {
			const url = new URL(request.url);
			if (
				request.method === 'GET' &&
				url.pathname === PORTABLE_MATERIALIZER_PATHS.records
			) {
				return new Response(
					new Blob([
						Uint8Array.from(encodePortableMaterializerRecordFrame(records)),
					]),
				);
			}
			if (request.method === 'GET' && url.pathname.startsWith('/blobs/')) {
				const bytes = blobBytes.get(url.pathname.slice('/blobs/'.length));
				expect(
					decodeURIComponent(
						request.headers.get(
							PORTABLE_MATERIALIZER_ADDRESS_HEADERS.namespace,
						) ?? '',
					),
				).toBe('so.epicenter.notes');
				return bytes === undefined
					? new Response(null, { status: 404 })
					: bytesResponse(bytes);
			}
			if (
				request.method === 'POST' &&
				url.pathname === PORTABLE_MATERIALIZER_PATHS.importBegin
			) {
				capture.begun = (await request.json()) as { recordCount: number };
				return new Response(null, { status: 204 });
			}
			if (
				request.method === 'POST' &&
				url.pathname === PORTABLE_MATERIALIZER_PATHS.importRecords
			) {
				const text = await request.text();
				for (const line of text.split('\n')) {
					if (line !== '') {
						capture.records.push(
							...decodePortableMaterializerRecordFrame(line),
						);
					}
				}
				return new Response(null, { status: 204 });
			}
			if (
				request.method === 'PUT' &&
				url.pathname.startsWith(`${PORTABLE_MATERIALIZER_PATHS.importBlobs}/`)
			) {
				expect(
					decodeURIComponent(
						request.headers.get(
							PORTABLE_MATERIALIZER_ADDRESS_HEADERS.collection,
						) ?? '',
					),
				).toBe('notes');
				capture.blobs.set(
					url.pathname.slice(
						PORTABLE_MATERIALIZER_PATHS.importBlobs.length + 1,
					),
					new Uint8Array(await request.arrayBuffer()),
				);
				return new Response(null, { status: 204 });
			}
			if (
				request.method === 'POST' &&
				url.pathname === PORTABLE_MATERIALIZER_PATHS.importSeal
			) {
				capture.sealed = true;
				return new Response(null, { status: 204 });
			}
			if (
				request.method === 'DELETE' &&
				url.pathname === PORTABLE_MATERIALIZER_PATHS.import
			) {
				capture.deleted = true;
				return new Response(null, { status: 204 });
			}
			return new Response(null, { status: 404 });
		},
	};
	return { capture, handler: createPortableTarMaterializer(fetcher) };
}

async function exportedArchive(
	records: PortableArtifactRecord[] = [FIRST, SECOND],
): Promise<Uint8Array> {
	const { handler } = setup(records);
	const response = await handler(
		new Request('http://materializer.test/export', { method: 'POST' }),
	);
	expect(response.status).toBe(200);
	expect(response.headers.get('content-type')).toBe('application/x-tar');
	return new Uint8Array(await response.arrayBuffer());
}

type TarSection = { path: string; start: number; end: number };

function tarSections(archive: Uint8Array): TarSection[] {
	const sections: TarSection[] = [];
	for (let offset = 0; offset + 512 <= archive.byteLength; ) {
		const header = archive.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const name = new TextDecoder().decode(
			header.subarray(0, header.indexOf(0)),
		);
		const prefixField = header.subarray(345, 500);
		const prefixEnd = prefixField.indexOf(0);
		const prefix = new TextDecoder().decode(
			prefixEnd === -1 ? prefixField : prefixField.subarray(0, prefixEnd),
		);
		const size = Number.parseInt(
			new TextDecoder().decode(header.subarray(124, 135)),
			8,
		);
		const end = offset + 512 + Math.ceil(size / 512) * 512;
		sections.push({
			path: prefix === '' ? name : `${prefix}/${name}`,
			start: offset,
			end,
		});
		offset = end;
	}
	return sections;
}

function tarEntrySize(archive: Uint8Array, section: TarSection): number {
	return Number.parseInt(
		new TextDecoder().decode(
			archive.subarray(section.start + 124, section.start + 135),
		),
		8,
	);
}

function concatenate(...parts: Uint8Array[]): Uint8Array {
	const output = new Uint8Array(
		parts.reduce((length, part) => length + part.byteLength, 0),
	);
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output;
}

function withChecksum(header: Uint8Array): Uint8Array {
	const changed = header.slice();
	changed.fill(0x20, 148, 156);
	const sum = changed.reduce((total, byte) => total + byte, 0);
	const checksum = `${sum.toString(8).padStart(6, '0')}\0 `;
	changed.set(new TextEncoder().encode(checksum), 148);
	return changed;
}

function replaceHeader(
	archive: Uint8Array,
	section: TarSection,
	header: Uint8Array,
) {
	const changed = archive.slice();
	changed.set(header, section.start);
	return changed;
}

async function expectImportRefusal(
	archive: Uint8Array,
): Promise<ImportCapture> {
	const { capture, handler } = setup();
	const response = await handler(
		new Request('http://materializer.test/import', {
			method: 'POST',
			body: new Blob([Uint8Array.from(archive)]),
		}),
	);
	expect(response.status).toBe(400);
	expect((await response.json()) as unknown).toEqual({
		error: 'invalid-portable-backup',
	});
	return capture;
}

async function temporaryMaterializerDirectories(): Promise<string[]> {
	return (await readdir(tmpdir()))
		.filter((name) => name.startsWith('epicenter-portable-'))
		.sort();
}

test('canonical TAR round-trips bounded records and exact blob streams', async () => {
	const before = await temporaryMaterializerDirectories();
	const archive = await exportedArchive();
	expect(tarSections(archive).map((section) => section.path)).toEqual([
		'epicenter.sqlite',
		...tarSections(archive)
			.slice(1)
			.map((section) => section.path)
			.sort(),
	]);

	const { capture, handler } = setup();
	const response = await handler(
		new Request('http://materializer.test/import', {
			method: 'POST',
			body: new Blob([Uint8Array.from(archive)]),
		}),
	);
	expect(response.status).toBe(204);
	expect(capture.begun).toEqual({ recordCount: 2 });
	expect(capture.records).toEqual([FIRST, SECOND]);
	expect(capture.blobs.size).toBe(2);
	for (const [record, bytes] of [
		[FIRST, FIRST_BYTES],
		[SECOND, SECOND_BYTES],
	] as const) {
		const owner = blobFileOwner(record.address, record.blobSha256 ?? '');
		expect(capture.blobs.get(`${owner.ownerKey}/${owner.digest}`)).toEqual(
			bytes,
		);
	}
	expect(capture.sealed).toBe(true);
	expect(capture.deleted).toBe(false);
	expect(await temporaryMaterializerDirectories()).toEqual(before);
});

test('record decoder bounds each frame rather than its coalesced transport chunk', async () => {
	const payload = 'x'.repeat(1_020_000);
	const frames = Array.from({ length: 33 }, (_, index) =>
		encodePortableMaterializerRecordFrame([
			{
				...FIRST,
				address: {
					...FIRST.address,
					recordKey: String(index).padStart(24, '0'),
				},
				scalar: { state: 'live', payload },
				documentUpdateV2: null,
				blobSha256: null,
			},
		]),
	);
	const coalesced = concatenate(...frames);
	expect(coalesced.byteLength).toBeGreaterThan(32 * 1024 * 1024);
	const decoded: PortableArtifactRecord[] = [];
	for await (const records of decodePortableMaterializerRecordStream(
		new ReadableStream({
			start(controller) {
				controller.enqueue(coalesced);
				controller.close();
			},
		}),
	)) {
		decoded.push(...records);
	}
	expect(decoded).toHaveLength(33);
});

test('import refuses malformed, non-file, and oversized TAR headers', async () => {
	const archive = await exportedArchive();
	const [index] = tarSections(archive);
	if (index === undefined) throw new Error('test archive omitted its index');

	const malformed = archive.slice();
	malformed[0] = (malformed[0] ?? 0) ^ 1;
	const symlinkHeader = archive
		.subarray(index.start, index.start + 512)
		.slice();
	symlinkHeader[156] = 0x32;
	const oversizedHeader = archive
		.subarray(index.start, index.start + 512)
		.slice();
	oversizedHeader.set(
		new TextEncoder().encode(
			`${(PORTABLE_SQLITE_INDEX_MAX_BYTES + 1).toString(8).padStart(11, '0')}\0`,
		),
		124,
	);
	const binaryChecksum = archive.slice();
	binaryChecksum[index.start + 148] = 0xff;
	const binaryNumericHeader = archive
		.subarray(index.start, index.start + 512)
		.slice();
	binaryNumericHeader[124] = 0xff;

	await expectImportRefusal(malformed);
	await expectImportRefusal(binaryChecksum);
	await expectImportRefusal(
		replaceHeader(archive, index, withChecksum(binaryNumericHeader)),
	);
	await expectImportRefusal(
		replaceHeader(archive, index, withChecksum(symlinkHeader)),
	);
	await expectImportRefusal(
		replaceHeader(archive, index, withChecksum(oversizedHeader)),
	);
});

test('import refuses wrong blob order, duplicate entries, and extra entries', async () => {
	const archive = await exportedArchive();
	const [index, first, second] = tarSections(archive);
	if (index === undefined || first === undefined || second === undefined) {
		throw new Error('test archive omitted expected entries');
	}
	const end = archive.subarray(second.end);
	const indexBytes = archive.subarray(index.start, index.end);
	const firstBytes = archive.subarray(first.start, first.end);
	const secondBytes = archive.subarray(second.start, second.end);

	for (const changed of [
		concatenate(indexBytes, secondBytes, firstBytes, end),
		concatenate(indexBytes, firstBytes, firstBytes, secondBytes, end),
		concatenate(indexBytes, firstBytes, secondBytes, firstBytes, end),
	]) {
		const capture = await expectImportRefusal(changed);
		expect(capture.deleted).toBe(true);
		expect(capture.sealed).toBe(false);
	}
});

test('import refuses missing and digest-corrupt blob membership', async () => {
	const archive = await exportedArchive();
	const [index, first, second] = tarSections(archive);
	if (index === undefined || first === undefined || second === undefined) {
		throw new Error('test archive omitted expected entries');
	}
	const end = archive.subarray(second.end);
	const missing = concatenate(
		archive.subarray(index.start, index.end),
		archive.subarray(first.start, first.end),
		end,
	);
	const corrupt = archive.slice();
	corrupt[first.start + 512] = (corrupt[first.start + 512] ?? 0) ^ 1;

	for (const changed of [missing, corrupt]) {
		const capture = await expectImportRefusal(changed);
		expect(capture.deleted).toBe(true);
		expect(capture.sealed).toBe(false);
	}
});

test('import refuses hidden bytes in index and blob padding', async () => {
	const archive = await exportedArchive();
	const [index, blob] = tarSections(archive);
	if (index === undefined || blob === undefined) {
		throw new Error('test archive omitted expected entries');
	}
	const blobPadding = archive.slice();
	blobPadding[blob.start + 512 + tarEntrySize(archive, blob)] = 1;
	await expectImportRefusal(blobPadding);

	const indexSize = tarEntrySize(archive, index);
	const shortenedHeader = archive
		.subarray(index.start, index.start + 512)
		.slice();
	shortenedHeader.set(
		new TextEncoder().encode(
			`${(indexSize - 1).toString(8).padStart(11, '0')}\0`,
		),
		124,
	);
	const indexPadding = replaceHeader(
		archive,
		index,
		withChecksum(shortenedHeader),
	);
	indexPadding[index.start + 512 + indexSize - 1] = 1;
	await expectImportRefusal(indexPadding);
});
