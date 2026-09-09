/**
 * Library recovery publication with real archive validation, SQLite and immutable files.
 * Imported file bytes survive unchanged; failures never publish and live retry
 * preserves the original capture. Restore and a durable client journal are absent.
 */
import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type BlobStore,
	BlobStoreError,
	generateBlobId,
} from '@epicenter/blobs';
import { createBunBlobStore } from '@epicenter/blobs/bun';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { captureArchive, prepareArchive } from './artifact/archive.js';
import { createLibraryRecovery } from './recovery.js';
import { openCurrentAuthority } from './sync/authority.js';

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});
async function setup() {
	const directory = await mkdtemp(join(tmpdir(), 'library-backups-'));
	directories.push(directory);
	const database = new Database(join(directory, 'authority.sqlite'));
	const authority = openCurrentAuthority({
		sqlite: createBunSqliteAdapter(database),
	});
	const identity = { appId: 'so.epicenter.notes', dataId: 'so.epicenter.data' };
	const library = `libraries/apps/${identity.appId}/personal/alice/data/${identity.dataId}`;
	const blobs = createBunBlobStore({ directory: join(directory, 'blobs') });
	const archives = createBunBlobStore({
		directory: join(directory, 'backups'),
	});
	const doc = new Y.Doc();
	const blobId = generateBlobId();
	expectOk(await blobs.put(blobId, new Blob(['audio'], { type: 'audio/wav' })));
	doc.get('root').setAttr('audio', blobId);
	doc.get('root').insert(0, 'original', { bold: true });
	authority.ensureCurrent(Y.encodeStateAsUpdateV2(doc));
	const resources = { authority, identity, library, blobs, archives };
	return {
		...resources,
		resources,
		directory,
		database,
		doc,
		blobId,
		recovery: createLibraryRecovery(resources),
		[Symbol.dispose]() {
			doc.destroy();
			database.close();
		},
	};
}

test('manual backup and pretty-printed import preserve exact files and embedded attachments after reopening', async () => {
	using s = await setup();
	const manual = expectOk(await s.recovery.backup());
	expect(manual).toMatchObject({
		...s.identity,
		reason: 'manual',
		source: { generation: 1, head: 1 },
		version: 2,
	});
	const saved = expectOk(await s.recovery.download(manual.id));
	const uploaded = new TextEncoder().encode(
		`\n${JSON.stringify(JSON.parse(new TextDecoder().decode(saved)), null, 2)}\n`,
	);
	const imported = expectOk(
		await s.recovery.import(new Blob([uploaded], { type: 'text/plain' })),
	);
	expect(imported.id).not.toBe(manual.id);
	expect(imported.reason).toBe('imported');
	expect(imported.byteLength).toBe(uploaded.length);
	expect(imported.digest).not.toBe(manual.digest);
	expect(s.authority.capture().generation).toBe(1);
	const database = new Database(join(s.directory, 'authority.sqlite'));
	try {
		const reopened = createLibraryRecovery({
			...s.resources,
			authority: openCurrentAuthority({
				sqlite: createBunSqliteAdapter(database),
			}),
			archives: createBunBlobStore({ directory: join(s.directory, 'backups') }),
		});
		expect(expectOk(reopened.list())).toHaveLength(2);
		const downloaded = expectOk(await reopened.download(imported.id));
		expect(downloaded).toEqual(new Uint8Array(uploaded));
		expectOk(await s.blobs.delete(s.blobId));
		const prepared = expectOk(
			await prepareArchive(expectOk(await reopened.download(manual.id))),
		);
		expect(await prepared.blobs[0]!.blob.text()).toBe('audio');
		expect(prepared.blobs[0]!.blob.type).toBe('audio/wav');
	} finally {
		database.close();
	}
});

test('invalid archives and incompatible app or data identities never write or publish', async () => {
	using s = await setup();
	let writes = 0;
	const recovery = createLibraryRecovery({
		...s.resources,
		archives: {
			get: s.archives.get,
			async put(id, blob) {
				writes++;
				return s.archives.put(id, blob);
			},
		},
	});
	const valid = expectOk(
		await captureArchive(s.authority.capture(), s.blobs, s.identity),
	);
	const v1 = JSON.parse(new TextDecoder().decode(valid));
	v1.version = 1;
	const missing = JSON.parse(new TextDecoder().decode(valid));
	delete missing.body.identity;
	for (const bytes of [
		new TextEncoder().encode('{}'),
		new TextEncoder().encode(JSON.stringify(v1)),
		new TextEncoder().encode(JSON.stringify(missing)),
		expectOk(
			await captureArchive(s.authority.capture(), s.blobs, {
				...s.identity,
				appId: 'so.other.app',
			}),
		),
		expectOk(
			await captureArchive(s.authority.capture(), s.blobs, {
				...s.identity,
				dataId: 'so.other.data',
			}),
		),
	])
		expectErr(await recovery.import(new Blob([new Uint8Array(bytes)])));
	expect(writes).toBe(0);
	expect(expectOk(recovery.list())).toEqual([]);
});

test('failed write, missing read-back, wrong bytes and wrong MIME never publish', async () => {
	for (const phase of ['write', 'missing', 'bytes', 'mime'] as const) {
		using s = await setup();
		const other = expectOk(
			await captureArchive(
				{ ...s.authority.capture(), generation: 9 },
				s.blobs,
				s.identity,
			),
		);
		const archives: Pick<BlobStore, 'put' | 'get'> = {
			async put(id, blob) {
				return phase === 'write'
					? BlobStoreError.BlobStoreFailed({ id, cause: 'disk full' })
					: s.archives.put(id, blob);
			},
			async get(id) {
				if (phase === 'missing') return BlobStoreError.BlobNotFound({ id });
				if (phase === 'bytes') {
					expect(other.length).toBe(expectOk(await s.archives.get(id)).size);
					return Ok(
						new Blob([new Uint8Array(other)], {
							type: 'application/json;charset=utf-8',
						}),
					);
				}
				const saved = expectOk(await s.archives.get(id));
				return Ok(
					new Blob([await saved.arrayBuffer()], { type: 'text/plain' }),
				);
			},
		};
		const recovery = createLibraryRecovery({ ...s.resources, archives });
		expectErr(await recovery.backup());
		expect(expectOk(recovery.list())).toEqual([]);
	}
});

test('retry after failed read-back preserves the original manual capture despite later accepted writes', async () => {
	using s = await setup();
	let failed = true;
	const recovery = createLibraryRecovery({
		...s.resources,
		archives: {
			put: s.archives.put,
			async get(id) {
				return failed
					? BlobStoreError.BlobStoreFailed({ id, cause: 'interrupted read' })
					: s.archives.get(id);
			},
		},
	});
	expectErr(await recovery.backup());
	const before = Y.encodeStateVector(s.doc);
	s.doc.get('root').insert(8, ' later');
	expectOk(s.authority.bind(1).append(Y.encodeStateAsUpdateV2(s.doc, before)));
	failed = false;
	const record = expectOk(await recovery.backup());
	expect(record.source).toEqual({ generation: 1, head: 1 });
	expect(s.authority.capture().head).toBe(2);
	expect(expectOk(recovery.list())).toEqual([record]);
	const restored = new Y.Doc();
	try {
		Y.applyUpdateV2(
			restored,
			expectOk(
				await prepareArchive(expectOk(await recovery.download(record.id))),
			).bytes,
		);
		expect(restored.get('root').toString()).toContain('>original</>');
	} finally {
		restored.destroy();
	}
});
