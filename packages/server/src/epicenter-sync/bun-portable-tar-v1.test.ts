/**
 * Bun Portable TAR Adapter Tests
 *
 * Verifies the filesystem boundary between sealed Bun Backup directories and
 * the canonical portable TAR materializer.
 *
 * Key behaviors:
 * - Scalar, document, and blob records round-trip into one atomically published directory
 * - Empty portable artifacts remain valid
 * - Invalid directory kinds and noncanonical TARs are refused
 * - Failed imports remove scratch state and never publish a Backup
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	type PortableArtifactRecord,
	readPortableArtifactIndexPage,
	writePortableArtifactIndex,
} from '@epicenter/data/portable';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';

import {
	bunPortableBlobPath,
	validateBunPortableDirectory,
} from './bun-backup-v1.js';
import { createBunPortableTarMaterializer } from './bun-portable-tar-v1.js';

const BLOB_BYTES = new TextEncoder().encode('portable Bun blob');
const BLOB_DIGEST = new Bun.CryptoHasher('sha256')
	.update(BLOB_BYTES)
	.digest('hex');

function documentUpdate(value: string): Uint8Array {
	const document = new Y.Doc({ gc: true });
	document.get('body').insert(0, value);
	const update = new Uint8Array(Y.encodeStateAsUpdateV2(document));
	document.destroy();
	return update;
}

const RECORDS: PortableArtifactRecord[] = [
	{
		address: {
			namespace: 'so.epicenter.notes',
			collection: 'notes',
			recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
		},
		scalar: { state: 'live', payload: { title: 'Portable' } },
		documentUpdateV2: documentUpdate('document bytes'),
		blobSha256: BLOB_DIGEST,
	},
	{
		address: {
			namespace: 'so.epicenter.notes',
			collection: 'notes',
			recordKey: 'bbbbbbbbbbbbbbbbbbbbbbbb',
		},
		scalar: { state: 'unset' },
		documentUpdateV2: null,
		blobSha256: null,
	},
];

async function pathExists(path: string): Promise<boolean> {
	return Bun.file(path).exists();
}

async function setup(records: PortableArtifactRecord[] = RECORDS) {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-bun-tar-test-'));
	const sourceDirectory = join(root, 'source');
	const temporaryDirectory = join(root, '.importing');
	const publishedDirectory = join(root, 'published');
	await mkdir(join(sourceDirectory, 'blobs'), { recursive: true });
	const raw = new Database(join(sourceDirectory, 'epicenter.sqlite'), {
		create: true,
		strict: true,
	});
	try {
		writePortableArtifactIndex({
			database: createBunSqliteAdapter(raw),
			records,
		});
	} finally {
		raw.close();
	}
	for (const record of records) {
		if (record.blobSha256 === null) continue;
		const path = bunPortableBlobPath(
			sourceDirectory,
			record.address,
			record.blobSha256,
		);
		await mkdir(join(path, '..'), { recursive: true });
		await writeFile(path, BLOB_BYTES);
	}
	return {
		root,
		sourceDirectory,
		temporaryDirectory,
		publishedDirectory,
	};
}

async function exportArchive(sourceDirectory: string): Promise<Uint8Array> {
	const materialize = createBunPortableTarMaterializer({
		exportDirectory: sourceDirectory,
	});
	const response = await materialize(
		new Request('http://materializer.test/export', { method: 'POST' }),
	);
	expect(response.status).toBe(200);
	return new Uint8Array(await response.arrayBuffer());
}

async function importArchive({
	archive,
	temporaryDirectory,
	publishedDirectory,
}: {
	archive: Uint8Array;
	temporaryDirectory: string;
	publishedDirectory: string;
}): Promise<Response> {
	const materialize = createBunPortableTarMaterializer({
		importTarget: { temporaryDirectory, publishedDirectory },
	});
	return materialize(
		new Request('http://materializer.test/import', {
			method: 'POST',
			body: new Blob([Uint8Array.from(archive)]),
		}),
	);
}

function withChecksum(header: Uint8Array): Uint8Array {
	const changed = header.slice();
	changed.fill(0x20, 148, 156);
	const sum = changed.reduce((total, byte) => total + byte, 0);
	changed.set(
		new TextEncoder().encode(`${sum.toString(8).padStart(6, '0')}\0 `),
		148,
	);
	return changed;
}

function firstBlobOffset(archive: Uint8Array): number {
	let offset = 0;
	for (;;) {
		const header = archive.subarray(offset, offset + 512);
		if (header.byteLength !== 512 || header.every((byte) => byte === 0)) {
			throw new Error('test archive omitted its blob');
		}
		const nameEnd = header.indexOf(0);
		const name = new TextDecoder().decode(header.subarray(0, nameEnd));
		const prefixField = header.subarray(345, 500);
		const prefixEnd = prefixField.indexOf(0);
		const prefix = new TextDecoder().decode(
			prefixEnd === -1 ? prefixField : prefixField.subarray(0, prefixEnd),
		);
		if (`${prefix}/${name}`.startsWith('blobs/')) return offset;
		const size = Number.parseInt(
			new TextDecoder().decode(header.subarray(124, 135)),
			8,
		);
		offset += 512 + Math.ceil(size / 512) * 512;
	}
}

test('canonical TAR round-trips scalar, document, and blob records before publishing', async () => {
	const { root, sourceDirectory, temporaryDirectory, publishedDirectory } =
		await setup();
	try {
		const archive = await exportArchive(sourceDirectory);
		const response = await importArchive({
			archive,
			temporaryDirectory,
			publishedDirectory,
		});

		expect(response.status).toBe(204);
		expect(await pathExists(temporaryDirectory)).toBe(false);
		expect(await validateBunPortableDirectory(publishedDirectory)).toEqual({
			recordCount: 2,
		});
		const raw = new Database(join(publishedDirectory, 'epicenter.sqlite'), {
			readonly: true,
			strict: true,
		});
		try {
			expect(
				readPortableArtifactIndexPage({
					database: createBunSqliteAdapter(raw),
				}).records,
			).toEqual(RECORDS);
		} finally {
			raw.close();
		}
		const blobRecord = RECORDS[0];
		if (blobRecord === undefined || blobRecord.blobSha256 === null) {
			throw new Error('test fixture omitted its blob');
		}
		expect(
			await readFile(
				bunPortableBlobPath(
					publishedDirectory,
					blobRecord.address,
					blobRecord.blobSha256,
				),
			),
		).toEqual(Buffer.from(BLOB_BYTES));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('empty portable TAR publishes a valid empty Backup', async () => {
	const { root, sourceDirectory, temporaryDirectory, publishedDirectory } =
		await setup([]);
	try {
		const response = await importArchive({
			archive: await exportArchive(sourceDirectory),
			temporaryDirectory,
			publishedDirectory,
		});
		expect(response.status).toBe(204);
		expect(await validateBunPortableDirectory(publishedDirectory)).toEqual({
			recordCount: 0,
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('export refuses a directory whose index has a non-portable kind', async () => {
	const { root, sourceDirectory } = await setup([]);
	try {
		const raw = new Database(join(sourceDirectory, 'epicenter.sqlite'), {
			strict: true,
		});
		try {
			raw.exec('PRAGMA ignore_check_constraints = ON');
			raw.exec("UPDATE _epicenter_artifact SET kind = 'snapshot'");
		} finally {
			raw.close();
		}
		const materialize = createBunPortableTarMaterializer({
			exportDirectory: sourceDirectory,
		});
		expect(
			materialize(
				new Request('http://materializer.test/export', { method: 'POST' }),
			),
		).rejects.toThrow();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('import refuses a noncanonical TAR header and removes scratch state', async () => {
	const { root, sourceDirectory, temporaryDirectory, publishedDirectory } =
		await setup();
	try {
		const archive = await exportArchive(sourceDirectory);
		const header = archive.subarray(0, 512).slice();
		header[156] = 0x32;
		archive.set(withChecksum(header), 0);
		const response = await importArchive({
			archive,
			temporaryDirectory,
			publishedDirectory,
		});
		expect(response.status).toBe(400);
		expect(await pathExists(temporaryDirectory)).toBe(false);
		expect(await pathExists(publishedDirectory)).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('digest-corrupt blob import removes partial bytes and never publishes', async () => {
	const { root, sourceDirectory, temporaryDirectory, publishedDirectory } =
		await setup();
	try {
		const archive = await exportArchive(sourceDirectory);
		const blobByte = firstBlobOffset(archive) + 512;
		archive[blobByte] = (archive[blobByte] ?? 0) ^ 1;
		const response = await importArchive({
			archive,
			temporaryDirectory,
			publishedDirectory,
		});
		expect(response.status).toBe(400);
		expect(await pathExists(temporaryDirectory)).toBe(false);
		expect(await pathExists(publishedDirectory)).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
