import { Database } from 'bun:sqlite';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import { blobFileOwner } from '@epicenter/data/blob-v1';
import {
	appendPortableArtifactScratchRecords,
	initializePortableArtifactScratchIndex,
	readPortableArtifactIndexPage,
} from '@epicenter/data/portable';
import type { RecordAddress } from '@epicenter/data/protocol/v1';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import {
	bunPortableBlobPath,
	validateBunPortableDirectory,
} from './bun-backup-v1.js';
import {
	PORTABLE_MATERIALIZER_ADDRESS_HEADERS,
	PORTABLE_MATERIALIZER_PATHS,
} from './portable-materializer-contract-v1.js';
import {
	decodePortableMaterializerRecordStream,
	encodePortableMaterializerRecordFrame,
} from './portable-record-stream-v1.js';
import {
	createPortableTarMaterializer,
	type PortableMaterializerFetcher,
} from './portable-tar-materializer.js';

const INDEX_FILE = 'epicenter.sqlite';
const BLOBS_DIRECTORY = 'blobs';
const BLOB_ROUTE = '/blobs/';
const HEX_64 = /^[a-f0-9]{64}$/u;

export type BunPortableTarImportTarget = {
	/** Unpublished sibling directory owned exclusively by this import. */
	temporaryDirectory: string;
	/** Absent final path that receives one atomic rename after validation. */
	publishedDirectory: string;
};

export type BunPortableTarMaterializerOptions =
	| {
			/** One immutable, already-sealed directory-form Backup to download. */
			exportDirectory: string;
			/** Optionally serve one upload through the same materializer. */
			importTarget?: BunPortableTarImportTarget;
	  }
	| {
			/** Optionally serve one sealed Backup through the same materializer. */
			exportDirectory?: string;
			/** One fresh target for a single TAR import. */
			importTarget: BunPortableTarImportTarget;
	  };

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw cause;
	}
}

async function syncPath(path: string): Promise<void> {
	const handle = await open(path, 'r');
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function decodedAddress(request: Request): RecordAddress {
	const encoded = {
		namespace: request.headers.get(
			PORTABLE_MATERIALIZER_ADDRESS_HEADERS.namespace,
		),
		collection: request.headers.get(
			PORTABLE_MATERIALIZER_ADDRESS_HEADERS.collection,
		),
		recordKey: request.headers.get(
			PORTABLE_MATERIALIZER_ADDRESS_HEADERS.recordKey,
		),
	};
	if (
		encoded.namespace === null ||
		encoded.collection === null ||
		encoded.recordKey === null
	) {
		throw new Error('portable materializer blob address is missing');
	}
	return {
		namespace: decodeURIComponent(encoded.namespace),
		collection: decodeURIComponent(encoded.collection),
		recordKey: decodeURIComponent(encoded.recordKey),
	};
}

function blobOwnerFromRequest(
	request: Request,
	routePrefix = BLOB_ROUTE,
): { address: RecordAddress; ownerKey: string; digest: string } {
	const path = new URL(request.url).pathname;
	if (!path.startsWith(routePrefix)) {
		throw new Error('portable materializer blob path is not recognized');
	}
	const [ownerKey, digest, ...extra] = path
		.slice(routePrefix.length)
		.split('/');
	if (
		extra.length !== 0 ||
		ownerKey === undefined ||
		digest === undefined ||
		!HEX_64.test(ownerKey) ||
		!HEX_64.test(digest)
	) {
		throw new Error('portable materializer blob path is not recognized');
	}
	const address = decodedAddress(request);
	const expected = blobFileOwner(address, digest);
	if (expected.ownerKey !== ownerKey) {
		throw new Error(
			'portable materializer blob owner does not match its address',
		);
	}
	return { address, ownerKey, digest };
}

function createExportRecordResponse(directory: string): Response {
	const raw = new Database(resolve(directory, INDEX_FILE), {
		readonly: true,
		strict: true,
	});
	const database = createBunSqliteAdapter(raw);
	let after: RecordAddress | undefined;
	let closed = false;
	function close(): void {
		if (closed) return;
		closed = true;
		raw.close();
	}
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			try {
				const page = readPortableArtifactIndexPage({ database, after });
				if (page.records.length === 0) {
					close();
					controller.close();
					return;
				}
				controller.enqueue(encodePortableMaterializerRecordFrame(page.records));
				if (page.nextAfter === undefined) {
					close();
					controller.close();
				} else {
					after = page.nextAfter;
				}
			} catch (cause) {
				close();
				controller.error(cause);
			}
		},
		cancel() {
			close();
		},
	});
	return new Response(body, {
		headers: { 'content-type': 'application/x-ndjson' },
	});
}

function createBunExportFetcher(
	directory: string,
): PortableMaterializerFetcher {
	const resolved = resolve(directory);
	return {
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (
				request.method === 'GET' &&
				path === PORTABLE_MATERIALIZER_PATHS.records
			) {
				await validateBunPortableDirectory(resolved);
				return createExportRecordResponse(resolved);
			}
			if (request.method === 'GET' && path.startsWith(BLOB_ROUTE)) {
				const owner = blobOwnerFromRequest(request);
				const expectedPath = bunPortableBlobPath(
					resolved,
					owner.address,
					owner.digest,
				);
				if (path !== `${BLOB_ROUTE}${owner.ownerKey}/${owner.digest}`) {
					return new Response(null, { status: 404 });
				}
				const info = await lstat(expectedPath).catch((cause) => {
					if ((cause as NodeJS.ErrnoException).code === 'ENOENT')
						return undefined;
					throw cause;
				});
				if (info === undefined || !info.isFile() || info.isSymbolicLink()) {
					return new Response(null, { status: 404 });
				}
				return new Response(Bun.file(expectedPath), {
					headers: { 'content-length': String(info.size) },
				});
			}
			return new Response(null, { status: 404 });
		},
	};
}

function assertImportTarget(target: BunPortableTarImportTarget): {
	temporaryDirectory: string;
	publishedDirectory: string;
	parent: string;
} {
	const temporaryDirectory = resolve(target.temporaryDirectory);
	const publishedDirectory = resolve(target.publishedDirectory);
	const parent = dirname(publishedDirectory);
	if (
		temporaryDirectory === publishedDirectory ||
		dirname(temporaryDirectory) !== parent ||
		basename(temporaryDirectory).length === 0 ||
		basename(publishedDirectory).length === 0
	) {
		throw new TypeError(
			'portable import temporary and published directories must be distinct siblings',
		);
	}
	return { temporaryDirectory, publishedDirectory, parent };
}

function createBunImportFetcher(
	target: BunPortableTarImportTarget,
): PortableMaterializerFetcher {
	const { temporaryDirectory, publishedDirectory, parent } =
		assertImportTarget(target);
	type Phase = 'idle' | 'begun' | 'records' | 'published' | 'deleted';
	let phase: Phase = 'idle';
	let expectedRecordCount = 0;
	let receivedRecordCount = 0;
	let raw: Database | undefined;

	async function begin(request: Request): Promise<Response> {
		if (phase !== 'idle') throw new Error('portable import already began');
		const payload = (await request.json()) as { recordCount?: unknown };
		if (
			!Number.isSafeInteger(payload.recordCount) ||
			(payload.recordCount as number) < 0
		) {
			throw new Error('portable import record count is not recognized');
		}
		expectedRecordCount = payload.recordCount as number;
		await mkdir(parent, { recursive: true });
		if (
			(await pathExists(temporaryDirectory)) ||
			(await pathExists(publishedDirectory))
		) {
			throw new Error('portable import target already exists');
		}
		await mkdir(resolve(temporaryDirectory, BLOBS_DIRECTORY), {
			recursive: true,
		});
		raw = new Database(resolve(temporaryDirectory, INDEX_FILE), {
			create: true,
			strict: true,
		});
		initializePortableArtifactScratchIndex(createBunSqliteAdapter(raw));
		phase = 'begun';
		return new Response(null, { status: 204 });
	}

	async function writeRecords(request: Request): Promise<Response> {
		if (phase !== 'begun' || raw === undefined || request.body === null) {
			throw new Error('portable import record stream is out of order');
		}
		try {
			const database = createBunSqliteAdapter(raw);
			for await (const records of decodePortableMaterializerRecordStream(
				request.body,
			)) {
				receivedRecordCount += appendPortableArtifactScratchRecords({
					database,
					records,
				});
			}
		} finally {
			raw.close();
			raw = undefined;
		}
		phase = 'records';
		return new Response(null, { status: 204 });
	}

	async function writeBlob(request: Request): Promise<Response> {
		if (phase !== 'records' || request.body === null) {
			throw new Error('portable import blob stream is out of order');
		}
		const owner = blobOwnerFromRequest(
			request,
			`${PORTABLE_MATERIALIZER_PATHS.importBlobs}/`,
		);
		const rawLength = request.headers.get('content-length');
		if (rawLength === null || !/^(?:0|[1-9][0-9]*)$/u.test(rawLength)) {
			throw new Error('portable import blob length is missing');
		}
		const expectedLength = Number(rawLength);
		if (!Number.isSafeInteger(expectedLength)) {
			throw new Error('portable import blob length is not recognized');
		}
		const path = bunPortableBlobPath(
			temporaryDirectory,
			owner.address,
			owner.digest,
		);
		const blobParent = dirname(path);
		await mkdir(blobParent, { recursive: true });
		const handle = await open(path, 'wx');
		const hasher = new Bun.CryptoHasher('sha256');
		let seen = 0;
		try {
			const reader = request.body.getReader();
			let completed = false;
			try {
				for (;;) {
					const result = await reader.read();
					if (result.done) {
						completed = true;
						break;
					}
					seen += result.value.byteLength;
					if (seen > expectedLength) {
						throw new Error('portable import blob length changed');
					}
					hasher.update(result.value);
					let offset = 0;
					while (offset < result.value.byteLength) {
						const written = await handle.write(
							result.value,
							offset,
							result.value.byteLength - offset,
						);
						if (written.bytesWritten === 0) {
							throw new Error('portable import blob write made no progress');
						}
						offset += written.bytesWritten;
					}
				}
			} finally {
				if (!completed) await reader.cancel().catch(() => undefined);
			}
			if (seen !== expectedLength || hasher.digest('hex') !== owner.digest) {
				throw new Error('portable import blob verification failed');
			}
			await handle.sync();
		} catch (cause) {
			await handle.close();
			await rm(path, { force: true });
			throw cause;
		}
		await handle.close();
		await syncPath(blobParent);
		await syncPath(resolve(temporaryDirectory, BLOBS_DIRECTORY));
		return new Response(null, { status: 204 });
	}

	async function seal(): Promise<Response> {
		if (phase !== 'records') {
			throw new Error('portable import cannot seal before its records');
		}
		if (receivedRecordCount !== expectedRecordCount) {
			throw new Error('portable import record count changed');
		}
		await validateBunPortableDirectory(temporaryDirectory);
		await syncPath(resolve(temporaryDirectory, INDEX_FILE));
		await syncPath(resolve(temporaryDirectory, BLOBS_DIRECTORY));
		await syncPath(temporaryDirectory);
		if (await pathExists(publishedDirectory)) {
			throw new Error('portable import published target already exists');
		}
		await rename(temporaryDirectory, publishedDirectory);
		phase = 'published';
		try {
			await syncPath(parent);
		} catch (cause) {
			// Rename is the publication point. Reconcile a visible complete Backup
			// instead of reporting failure and inviting a duplicate retry.
			try {
				await validateBunPortableDirectory(publishedDirectory);
			} catch {
				throw cause;
			}
		}
		return new Response(null, { status: 204 });
	}

	async function discard(): Promise<Response> {
		raw?.close();
		raw = undefined;
		if (phase !== 'published') {
			await rm(temporaryDirectory, { recursive: true, force: true });
			if (await pathExists(parent)) await syncPath(parent);
		}
		phase = 'deleted';
		return new Response(null, { status: 204 });
	}

	return {
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (
				request.method === 'POST' &&
				path === PORTABLE_MATERIALIZER_PATHS.importBegin
			) {
				return begin(request);
			}
			if (
				request.method === 'POST' &&
				path === PORTABLE_MATERIALIZER_PATHS.importRecords
			) {
				return writeRecords(request);
			}
			if (
				request.method === 'PUT' &&
				path.startsWith(`${PORTABLE_MATERIALIZER_PATHS.importBlobs}/`)
			) {
				return writeBlob(request);
			}
			if (
				request.method === 'POST' &&
				path === PORTABLE_MATERIALIZER_PATHS.importSeal
			) {
				return seal();
			}
			if (
				request.method === 'DELETE' &&
				path === PORTABLE_MATERIALIZER_PATHS.import
			) {
				return discard();
			}
			return new Response(null, { status: 404 });
		},
	};
}

/** Materialize canonical portable TARs at Bun's sealed-directory boundary. */
export function createBunPortableTarMaterializer(
	options: BunPortableTarMaterializerOptions,
): (request: Request) => Promise<Response> {
	if (
		options.exportDirectory === undefined &&
		options.importTarget === undefined
	) {
		throw new TypeError('portable TAR materializer requires an operation');
	}
	const exportFetcher =
		options.exportDirectory === undefined
			? undefined
			: createBunExportFetcher(options.exportDirectory);
	const importFetcher =
		options.importTarget === undefined
			? undefined
			: createBunImportFetcher(options.importTarget);
	return createPortableTarMaterializer({
		fetch(request) {
			const path = new URL(request.url).pathname;
			return path === PORTABLE_MATERIALIZER_PATHS.records ||
				path.startsWith(BLOB_ROUTE)
				? (exportFetcher?.fetch(request) ??
						Promise.resolve(new Response(null, { status: 404 })))
				: (importFetcher?.fetch(request) ??
						Promise.resolve(new Response(null, { status: 404 })));
		},
	});
}
