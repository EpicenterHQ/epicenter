import { Database } from 'bun:sqlite';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { blobFileOwner } from '@epicenter/data/blob-v1';
import {
	appendPortableArtifactScratchRecords,
	initializePortableArtifactScratchIndex,
	readPortableArtifactIndexPage,
	scanPortableArtifactIndex,
} from '@epicenter/data/portable';
import type { RecordAddress } from '@epicenter/data/protocol/v1';
import type { SqliteRow } from '@epicenter/sqlite';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import {
	PORTABLE_MATERIALIZER_ADDRESS_HEADERS,
	PORTABLE_MATERIALIZER_PATHS,
	PORTABLE_SQLITE_INDEX_MAX_BYTES,
} from './portable-materializer-contract-v1.js';
import {
	decodePortableMaterializerRecordStream,
	encodePortableMaterializerRecordFrame,
} from './portable-record-stream-v1.js';

const INTERNAL_ORIGIN = 'http://epicenter.internal';
const INDEX_PATH = 'epicenter.sqlite';
const TAR_BLOCK_BYTES = 512;
const MAX_TAR_ENTRY_BYTES = 0o77777777777;
const RECORD_PAGE_LIMIT = 16;
const HEX_64 = /^[a-f0-9]{64}$/u;
const ZERO_BLOCK = new Uint8Array(TAR_BLOCK_BYTES);
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export class InvalidPortableBackupError extends Error {
	override name = 'InvalidPortableBackupError';
}

function invalidPortableBackup(message: string): never {
	throw new InvalidPortableBackupError(message);
}

function decodeTarField(bytes: Uint8Array): string {
	try {
		return decoder.decode(bytes);
	} catch {
		invalidPortableBackup('portable TAR header is not canonical');
	}
}

export {
	PORTABLE_MATERIALIZER_ADDRESS_HEADERS,
	PORTABLE_MATERIALIZER_PATHS,
	PORTABLE_SQLITE_INDEX_MAX_BYTES,
} from './portable-materializer-contract-v1.js';

export type PortableMaterializerFetcher = {
	fetch(request: Request): Promise<Response>;
};

type ManifestRow = SqliteRow & {
	path: string;
	namespace: string;
	collection: string;
	record_key: string;
	digest: string;
};

function internalRequest(path: string, init?: RequestInit): Request {
	return new Request(`${INTERNAL_ORIGIN}${path}`, init);
}

async function expectInternalResponse(
	fetcher: PortableMaterializerFetcher,
	request: Request,
): Promise<Response> {
	const response = await fetcher.fetch(request);
	if (!response.ok) {
		throw new Error(
			`portable materializer internal request failed: ${request.method} ${new URL(request.url).pathname} (${response.status})`,
		);
	}
	return response;
}

function createRecordStream(raw: Database): ReadableStream<Uint8Array> {
	const database = createBunSqliteAdapter(raw);
	let after: RecordAddress | undefined;
	let done = false;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (done) return;
			const page = readPortableArtifactIndexPage({ database, after });
			if (page.records.length === 0) {
				done = true;
				controller.close();
				return;
			}
			controller.enqueue(encodePortableMaterializerRecordFrame(page.records));
			if (page.nextAfter === undefined) {
				done = true;
				controller.close();
			} else {
				after = page.nextAfter;
			}
		},
	});
}

function manifestAddressHeaders(row: ManifestRow): Headers {
	return new Headers({
		[PORTABLE_MATERIALIZER_ADDRESS_HEADERS.namespace]: encodeURIComponent(
			row.namespace,
		),
		[PORTABLE_MATERIALIZER_ADDRESS_HEADERS.collection]: encodeURIComponent(
			row.collection,
		),
		[PORTABLE_MATERIALIZER_ADDRESS_HEADERS.recordKey]: encodeURIComponent(
			row.record_key,
		),
	});
}

function createManifest(directory: string, index: Database): Database {
	const manifest = new Database(join(directory, 'manifest.sqlite'), {
		create: true,
		strict: true,
	});
	try {
		manifest.exec(
			`CREATE TABLE blobs (
				path TEXT PRIMARY KEY,
				namespace TEXT NOT NULL,
				collection TEXT NOT NULL,
				record_key TEXT NOT NULL,
				digest TEXT NOT NULL
			) STRICT, WITHOUT ROWID`,
		);
		const insert = manifest.prepare(
			`INSERT INTO blobs (path, namespace, collection, record_key, digest)
			VALUES (?, ?, ?, ?, ?)`,
		);
		scanPortableArtifactIndex({
			database: createBunSqliteAdapter(index),
			onPage(page) {
				manifest.transaction(() => {
					for (const record of page) {
						if (record.blobSha256 === null) continue;
						const owner = blobFileOwner(record.address, record.blobSha256);
						insert.run(
							`blobs/${owner.ownerKey}/${owner.digest}`,
							record.address.namespace,
							record.address.collection,
							record.address.recordKey,
							owner.digest,
						);
					}
				})();
			},
		});
		return manifest;
	} catch (cause) {
		manifest.close();
		throw cause;
	}
}

function readManifestPage(manifest: Database, after?: string): ManifestRow[] {
	return manifest
		.query<ManifestRow, [string, number] | [number]>(
			`SELECT path, namespace, collection, record_key, digest FROM blobs
			${after === undefined ? '' : 'WHERE path > ?'} ORDER BY path LIMIT ?`,
		)
		.all(
			...(after === undefined
				? [RECORD_PAGE_LIMIT]
				: [after, RECORD_PAGE_LIMIT]),
		);
}

function writeText(
	target: Uint8Array,
	offset: number,
	length: number,
	value: string,
): void {
	const bytes = encoder.encode(value);
	if (bytes.byteLength > length)
		throw new Error('portable TAR path is too long');
	target.set(bytes, offset);
}

function octal(value: number, digits: number): string {
	const encoded = value.toString(8);
	if (encoded.length > digits)
		throw new Error('portable TAR entry is too large');
	return encoded.padStart(digits, '0');
}

function tarHeader(path: string, size: number): Uint8Array {
	if (!Number.isSafeInteger(size) || size < 0 || size > MAX_TAR_ENTRY_BYTES) {
		throw new Error('portable TAR entry is too large');
	}
	const header = new Uint8Array(TAR_BLOCK_BYTES);
	const parts = path.startsWith('blobs/') ? path.split('/') : undefined;
	if (parts === undefined) {
		writeText(header, 0, 100, path);
	} else {
		if (
			parts.length !== 3 ||
			parts[0] !== 'blobs' ||
			!HEX_64.test(parts[1] ?? '') ||
			!HEX_64.test(parts[2] ?? '')
		) {
			throw new Error('portable TAR blob path is not recognized');
		}
		writeText(header, 0, 100, parts[2] ?? '');
		writeText(header, 345, 155, `blobs/${parts[1]}`);
	}
	writeText(header, 100, 8, '0000644\0');
	writeText(header, 108, 8, '0000000\0');
	writeText(header, 116, 8, '0000000\0');
	writeText(header, 124, 12, `${octal(size, 11)}\0`);
	writeText(header, 136, 12, '00000000000\0');
	header.fill(0x20, 148, 156);
	header[156] = 0x30;
	writeText(header, 257, 6, 'ustar\0');
	writeText(header, 263, 2, '00');
	const checksum = header.reduce((sum, byte) => sum + byte, 0);
	writeText(header, 148, 8, `${octal(checksum, 6)}\0 `);
	return header;
}

function padding(size: number): Uint8Array {
	const bytes = (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
	return new Uint8Array(bytes);
}

async function readZeroPadding(reader: TarReader, size: number): Promise<void> {
	const bytes = await reader.readExact(padding(size).byteLength);
	if (bytes.some((byte) => byte !== 0)) {
		invalidPortableBackup('portable TAR padding is not canonical');
	}
}

function streamFromGenerator(
	generator: AsyncGenerator<Uint8Array>,
): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const result = await generator.next();
				if (result.done) controller.close();
				else controller.enqueue(result.value);
			} catch (cause) {
				controller.error(cause);
			}
		},
		async cancel() {
			await generator.return(undefined);
		},
	});
}

async function* fileChunks(path: string): AsyncGenerator<Uint8Array> {
	for await (const chunk of createReadStream(path)) {
		yield new Uint8Array(chunk);
	}
}

async function* verifiedBlobChunks(
	response: Response,
	digest: string,
	expectedSize: number,
): AsyncGenerator<Uint8Array> {
	if (response.body === null)
		throw new Error('portable Backup blob bytes are missing');
	const hasher = new Bun.CryptoHasher('sha256');
	let seen = 0;
	const reader = response.body.getReader();
	let completed = false;
	try {
		for (;;) {
			const result = await reader.read();
			if (result.done) {
				completed = true;
				break;
			}
			seen += result.value.byteLength;
			if (seen > expectedSize) {
				throw new Error('portable Backup blob length changed');
			}
			hasher.update(result.value);
			yield result.value;
		}
	} finally {
		if (!completed) await reader.cancel().catch(() => undefined);
	}
	if (seen !== expectedSize)
		throw new Error('portable Backup blob length changed');
	if (hasher.digest('hex') !== digest) {
		throw new Error('portable Backup blob digest verification failed');
	}
}

function contentLength(response: Response): number {
	const raw = response.headers.get('content-length');
	if (raw === null || !/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
		throw new Error('portable Backup blob length is missing');
	}
	const size = Number(raw);
	if (!Number.isSafeInteger(size) || size > MAX_TAR_ENTRY_BYTES) {
		throw new Error('portable TAR entry is too large');
	}
	return size;
}

async function buildExportIndex(
	fetcher: PortableMaterializerFetcher,
	directory: string,
): Promise<{ index: Database; manifest: Database; indexPath: string }> {
	const response = await expectInternalResponse(
		fetcher,
		internalRequest(PORTABLE_MATERIALIZER_PATHS.records),
	);
	if (response.body === null)
		throw new Error('portable record stream is missing');
	const indexPath = join(directory, INDEX_PATH);
	const index = new Database(indexPath, { create: true, strict: true });
	try {
		const database = createBunSqliteAdapter(index);
		initializePortableArtifactScratchIndex(database);
		for await (const records of decodePortableMaterializerRecordStream(
			response.body,
		)) {
			appendPortableArtifactScratchRecords({
				database,
				records,
			});
		}
		const manifest = createManifest(directory, index);
		return { index, manifest, indexPath };
	} catch (cause) {
		index.close();
		throw cause;
	}
}

async function exportPortableTar(
	fetcher: PortableMaterializerFetcher,
): Promise<Response> {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-portable-export-'));
	try {
		const built = await buildExportIndex(fetcher, directory);
		built.index.close();
		const indexSize = (await stat(built.indexPath)).size;
		if (indexSize > PORTABLE_SQLITE_INDEX_MAX_BYTES) {
			built.manifest.close();
			throw new Error('portable SQLite index exceeds its byte bound');
		}
		const body = streamFromGenerator(
			(async function* () {
				try {
					yield tarHeader(INDEX_PATH, indexSize);
					yield* fileChunks(built.indexPath);
					yield padding(indexSize);
					let after: string | undefined;
					for (;;) {
						const page = readManifestPage(built.manifest, after);
						if (page.length === 0) break;
						for (const blob of page) {
							const response = await expectInternalResponse(
								fetcher,
								internalRequest(`/${blob.path}`, {
									headers: manifestAddressHeaders(blob),
								}),
							);
							const size = contentLength(response);
							yield tarHeader(blob.path, size);
							yield* verifiedBlobChunks(response, blob.digest, size);
							yield padding(size);
						}
						after = page.at(-1)?.path;
					}
					yield ZERO_BLOCK;
					yield ZERO_BLOCK;
				} finally {
					built.manifest.close();
					await rm(directory, { recursive: true, force: true });
				}
			})(),
		);
		return new Response(body, {
			headers: { 'content-type': 'application/x-tar' },
		});
	} catch (cause) {
		await rm(directory, { recursive: true, force: true });
		throw cause;
	}
}

class TarReader {
	private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
	private pending = new Uint8Array(0);
	private ended = false;

	constructor(stream: ReadableStream<Uint8Array>) {
		this.reader = stream.getReader();
	}

	async readExact(length: number): Promise<Uint8Array> {
		const output = new Uint8Array(length);
		let offset = 0;
		while (offset < length) {
			if (this.pending.byteLength === 0) {
				const result = await this.reader.read();
				if (result.done)
					invalidPortableBackup('portable TAR ended unexpectedly');
				this.pending = new Uint8Array(result.value);
			}
			const count = Math.min(length - offset, this.pending.byteLength);
			output.set(this.pending.subarray(0, count), offset);
			offset += count;
			this.pending = this.pending.slice(count);
		}
		return output;
	}

	async readAtMost(length: number): Promise<Uint8Array> {
		if (this.pending.byteLength === 0) {
			const result = await this.reader.read();
			if (result.done) invalidPortableBackup('portable TAR ended unexpectedly');
			this.pending = new Uint8Array(result.value);
		}
		const count = Math.min(length, this.pending.byteLength);
		const output = this.pending.slice(0, count);
		this.pending = this.pending.slice(count);
		return output;
	}

	async assertEnd(): Promise<void> {
		if (this.pending.byteLength !== 0) {
			invalidPortableBackup('portable TAR has trailing bytes');
		}
		const result = await this.reader.read();
		if (!result.done) invalidPortableBackup('portable TAR has trailing bytes');
		this.ended = true;
	}

	async close(): Promise<void> {
		if (!this.ended) await this.reader.cancel().catch(() => undefined);
	}
}

function nullTerminatedAscii(
	header: Uint8Array,
	offset: number,
	length: number,
): string {
	const field = header.subarray(offset, offset + length);
	const end = field.indexOf(0);
	const used = end === -1 ? field : field.subarray(0, end);
	if (end !== -1 && field.subarray(end).some((byte) => byte !== 0)) {
		invalidPortableBackup('portable TAR header is not canonical');
	}
	if (used.some((byte) => byte < 0x20 || byte > 0x7e)) {
		invalidPortableBackup('portable TAR header is not canonical');
	}
	return decodeTarField(used);
}

function parseOctalField(
	header: Uint8Array,
	offset: number,
	length: number,
): number {
	const field = decodeTarField(header.subarray(offset, offset + length));
	if (!/^[0-7]+\0$/u.test(field)) {
		invalidPortableBackup('portable TAR numeric field is not canonical');
	}
	const value = Number.parseInt(field.slice(0, -1), 8);
	if (!Number.isSafeInteger(value) || value > MAX_TAR_ENTRY_BYTES) {
		invalidPortableBackup('portable TAR entry is too large');
	}
	return value;
}

function parseHeader(
	header: Uint8Array,
): { path: string; size: number } | undefined {
	if (header.every((byte) => byte === 0)) return undefined;
	const checksumField = decodeTarField(header.subarray(148, 156));
	if (!/^[0-7]{6}\0 $/u.test(checksumField)) {
		invalidPortableBackup('portable TAR checksum is not canonical');
	}
	const expected = Number.parseInt(checksumField.slice(0, 6), 8);
	const copy = header.slice();
	copy.fill(0x20, 148, 156);
	if (copy.reduce((sum, byte) => sum + byte, 0) !== expected) {
		invalidPortableBackup('portable TAR checksum is invalid');
	}
	if (
		decodeTarField(header.subarray(100, 108)) !== '0000644\0' ||
		decodeTarField(header.subarray(108, 116)) !== '0000000\0' ||
		decodeTarField(header.subarray(116, 124)) !== '0000000\0' ||
		decodeTarField(header.subarray(136, 148)) !== '00000000000\0' ||
		header[156] !== 0x30 ||
		decodeTarField(header.subarray(257, 263)) !== 'ustar\0' ||
		decodeTarField(header.subarray(263, 265)) !== '00' ||
		header.subarray(157, 257).some((byte) => byte !== 0) ||
		header.subarray(265, 345).some((byte) => byte !== 0) ||
		header.subarray(500).some((byte) => byte !== 0)
	) {
		invalidPortableBackup('portable TAR header is not canonical');
	}
	const name = nullTerminatedAscii(header, 0, 100);
	const prefix = nullTerminatedAscii(header, 345, 155);
	const path = prefix === '' ? name : `${prefix}/${name}`;
	return { path, size: parseOctalField(header, 124, 12) };
}

async function writeIndexEntry(
	reader: TarReader,
	path: string,
	size: number,
): Promise<void> {
	const handle = await open(path, 'wx');
	let remaining = size;
	try {
		while (remaining > 0) {
			const chunk = await reader.readAtMost(Math.min(64 * 1024, remaining));
			let offset = 0;
			while (offset < chunk.byteLength) {
				const result = await handle.write(
					chunk,
					offset,
					chunk.byteLength - offset,
				);
				if (result.bytesWritten === 0) {
					throw new Error('portable TAR index write made no progress');
				}
				offset += result.bytesWritten;
			}
			remaining -= chunk.byteLength;
		}
		await handle.sync();
	} finally {
		await handle.close();
	}
	await readZeroPadding(reader, size);
}

function streamTarEntry(
	reader: TarReader,
	size: number,
	digest: string,
): { body: ReadableStream<Uint8Array>; completed: Promise<void> } {
	let remaining = size;
	const hasher = new Bun.CryptoHasher('sha256');
	let resolve!: () => void;
	let reject!: (cause: unknown) => void;
	const completed = new Promise<void>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				if (remaining > 0) {
					const chunk = await reader.readAtMost(Math.min(64 * 1024, remaining));
					remaining -= chunk.byteLength;
					hasher.update(chunk);
					controller.enqueue(chunk);
					return;
				}
				await readZeroPadding(reader, size);
				if (hasher.digest('hex') !== digest) {
					invalidPortableBackup('portable TAR blob digest verification failed');
				}
				controller.close();
				resolve();
			} catch (cause) {
				controller.error(cause);
				reject(cause);
			}
		},
		cancel(cause) {
			reject(cause ?? new Error('portable TAR blob import was cancelled'));
		},
	});
	return { body, completed };
}

async function deleteIncompleteImport(
	fetcher: PortableMaterializerFetcher,
): Promise<void> {
	await fetcher
		.fetch(
			internalRequest(PORTABLE_MATERIALIZER_PATHS.import, { method: 'DELETE' }),
		)
		.catch(() => undefined);
}

async function importPortableTar(
	fetcher: PortableMaterializerFetcher,
	request: Request,
): Promise<Response> {
	if (request.body === null)
		invalidPortableBackup('portable TAR request body is missing');
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-portable-import-'));
	const reader = new TarReader(request.body);
	let index: Database | undefined;
	let manifest: Database | undefined;
	let importStarted = false;
	try {
		const first = parseHeader(await reader.readExact(TAR_BLOCK_BYTES));
		if (first === undefined || first.path !== INDEX_PATH || first.size === 0) {
			invalidPortableBackup('portable TAR must begin with epicenter.sqlite');
		}
		if (first.size > PORTABLE_SQLITE_INDEX_MAX_BYTES) {
			invalidPortableBackup('portable SQLite index exceeds its byte bound');
		}
		const indexPath = join(directory, INDEX_PATH);
		await writeIndexEntry(reader, indexPath, first.size);
		try {
			index = new Database(indexPath, { readonly: true, strict: true });
		} catch {
			invalidPortableBackup('portable SQLite index is not recognized');
		}
		let metadata: ReturnType<typeof scanPortableArtifactIndex>;
		try {
			metadata = scanPortableArtifactIndex({
				database: createBunSqliteAdapter(index),
				onPage: () => undefined,
			});
		} catch {
			invalidPortableBackup('portable SQLite index is not recognized');
		}
		manifest = createManifest(directory, index);
		importStarted = true;
		await expectInternalResponse(
			fetcher,
			internalRequest(PORTABLE_MATERIALIZER_PATHS.importBegin, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ recordCount: metadata.recordCount }),
			}),
		);
		await expectInternalResponse(
			fetcher,
			internalRequest(PORTABLE_MATERIALIZER_PATHS.importRecords, {
				method: 'POST',
				headers: { 'content-type': 'application/x-ndjson' },
				body: createRecordStream(index),
			}),
		);

		let after: string | undefined;
		for (;;) {
			const page = readManifestPage(manifest, after);
			if (page.length === 0) break;
			for (const expected of page) {
				const header = parseHeader(await reader.readExact(TAR_BLOCK_BYTES));
				if (header === undefined) {
					invalidPortableBackup('portable TAR blob membership is incomplete');
				}
				if (header.path !== expected.path) {
					invalidPortableBackup(
						'portable TAR blob order or membership is not canonical',
					);
				}
				const entry = streamTarEntry(reader, header.size, expected.digest);
				const blobHeaders = manifestAddressHeaders(expected);
				blobHeaders.set('content-length', String(header.size));
				await Promise.all([
					expectInternalResponse(
						fetcher,
						internalRequest(
							`${PORTABLE_MATERIALIZER_PATHS.importBlobs}/${expected.path.slice('blobs/'.length)}`,
							{
								method: 'PUT',
								headers: blobHeaders,
								body: entry.body,
							},
						),
					),
					entry.completed,
				]);
			}
			after = page.at(-1)?.path;
		}
		const firstEnd = parseHeader(await reader.readExact(TAR_BLOCK_BYTES));
		const secondEnd = parseHeader(await reader.readExact(TAR_BLOCK_BYTES));
		if (firstEnd !== undefined || secondEnd !== undefined) {
			invalidPortableBackup('portable TAR contains an unexpected entry');
		}
		await reader.assertEnd();
		await expectInternalResponse(
			fetcher,
			internalRequest(PORTABLE_MATERIALIZER_PATHS.importSeal, {
				method: 'POST',
			}),
		);
		return new Response(null, { status: 204 });
	} catch (cause) {
		if (importStarted) await deleteIncompleteImport(fetcher);
		throw cause;
	} finally {
		manifest?.close();
		index?.close();
		await reader.close();
		await rm(directory, { recursive: true, force: true });
	}
}

/** Create the Bun materializer HTTP boundary used by a local process or Container. */
export function createPortableTarMaterializer(
	fetcher: PortableMaterializerFetcher,
): (request: Request) => Promise<Response> {
	return async (request) => {
		const url = new URL(request.url);
		if (request.method !== 'POST') return new Response(null, { status: 405 });
		try {
			switch (url.pathname) {
				case PORTABLE_MATERIALIZER_PATHS.export:
					return await exportPortableTar(fetcher);
				case PORTABLE_MATERIALIZER_PATHS.import:
					return await importPortableTar(fetcher, request);
				default:
					return new Response(null, { status: 404 });
			}
		} catch (cause) {
			if (cause instanceof InvalidPortableBackupError) {
				return Response.json(
					{ error: 'invalid-portable-backup' },
					{ status: 400 },
				);
			}
			throw cause;
		}
	};
}
