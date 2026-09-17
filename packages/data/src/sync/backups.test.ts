/**
 * Backup publication through the stable authority and immutable filesystem storage.
 * Proves visibility after read-back, exact imported downloads, restart with a
 * retained request, isolation, and catalog survival across generation replacement.
 * Does not prove public-action restart reconciliation or power-loss durability.
 */
import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStoreError, generateBlobId } from '@epicenter/blobs';
import { createBunBlobStore } from '@epicenter/blobs/bun';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openCurrentAuthority } from './authority.js';

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), 'backup-publication-'));
	directories.push(directory);
	const path = join(directory, 'authority.sqlite');
	const database = new Database(path);
	const sqlite = createBunSqliteAdapter(database);
	const authority = openCurrentAuthority({ sqlite });
	authority.ensureCurrent(new Uint8Array([1]));
	const archives = createBunBlobStore({
		directory: join(directory, 'backups'),
	});
	const library =
		'libraries/apps/so.epicenter.notes/personal/alice/data/so.epicenter.notes';
	const metadata = {
		appId: 'so.epicenter.notes',
		dataId: 'so.epicenter.notes',
		version: 3,
		source: { generation: 1, head: 1 },
	};
	// The authority is byte-opaque. Real codec composition is tested in recovery.test.ts.
	const identity = { appId: metadata.appId, dataId: metadata.dataId };
	const backups = authority.backups({ library, archives, identity });
	const request = {
		id: generateBlobId('json'),
		reason: 'imported' as const,
		metadata,
		bytes: new TextEncoder().encode('  original bytes\n'),
	};
	return {
		directory,
		path,
		database,
		sqlite,
		authority,
		archives,
		library,
		identity,
		backups,
		request,
	};
}

test('publication remains invisible until immutable read-back completes', async () => {
	const s = await setup();
	try {
		const reading = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const backups = s.authority.backups({
			library: s.library,
			identity: s.identity,
			archives: {
				put: s.archives.put,
				async get(id) {
					reading.resolve();
					await resume.promise;
					return s.archives.get(id);
				},
			},
		});
		const publishing = backups.publish(s.request);
		await reading.promise;
		expect(expectOk(backups.list())).toEqual([]);
		expect(expectErr(await backups.download(s.request.id)).name).toBe(
			'BackupNotFound',
		);
		resume.resolve();
		const record = expectOk(await publishing);
		expect(record.id).toBe(s.request.id);
		expect(expectOk(backups.list())).toEqual([record]);
		expect(expectOk(await backups.download(record.id))).toEqual(
			new Uint8Array(s.request.bytes),
		);
	} finally {
		s.database.close();
	}
});

test('failed SQL finalization leaves no published record and a retained request publishes once after reopen', async () => {
	const s = await setup();
	s.database.run(
		`CREATE TRIGGER fail_publication BEFORE UPDATE OF added_at ON _backups BEGIN SELECT RAISE(ABORT, 'interrupted publication'); END`,
	);
	expectErr(await s.backups.publish(s.request));
	expect(expectOk(s.backups.list())).toEqual([]);
	expectOk(await s.archives.get(s.request.id));
	s.database.close();
	const database = new Database(s.path);
	try {
		database.run('DROP TRIGGER fail_publication');
		const authority = openCurrentAuthority({
			sqlite: createBunSqliteAdapter(database),
		});
		const backups = authority.backups({
			library: s.library,
			archives: s.archives,
			identity: s.identity,
		});
		const first = expectOk(await backups.publish(s.request));
		expect(expectOk(await backups.publish(s.request))).toEqual(first);
		expect(expectOk(backups.list())).toEqual([first]);
		expect(expectOk(await backups.download(first.id))).toEqual(
			new Uint8Array(s.request.bytes),
		);
		expectErr(
			await backups.publish({ ...s.request, bytes: new Uint8Array([7]) }),
		);
		expectErr(await backups.publish({ ...s.request, reason: 'manual' }));
	} finally {
		database.close();
	}
});

test('catalog survives generation replacement and another library cannot resolve its id', async () => {
	const s = await setup();
	const otherDatabase = new Database(':memory:');
	try {
		const record = expectOk(await s.backups.publish(s.request));
		(
			await s.authority.prepareActivation({
				operation: 'test-replacement',
				expected: s.authority.capture(),
				bytes: new Uint8Array([2]),
			})
		).activate();
		expect(expectOk(s.backups.list())).toEqual([record]);
		const other = openCurrentAuthority({
			sqlite: createBunSqliteAdapter(otherDatabase),
		}).backups({
			library: s.library.replace('alice', 'bob'),
			archives: s.archives,
			identity: s.identity,
		});
		expect(expectOk(other.list())).toEqual([]);
		expect(expectErr(await other.download(record.id)).name).toBe(
			'BackupNotFound',
		);
		expect(() =>
			s.authority.backups({
				library: 'wrong-library',
				archives: s.archives,
				identity: s.identity,
			}),
		).toThrow();
	} finally {
		otherDatabase.close();
		s.database.close();
	}
});

test('concurrent exact requests publish one pre-restore record and committed retry needs no object read', async () => {
	const s = await setup();
	try {
		const request = { ...s.request, reason: 'before-restore' as const };
		const records = await Promise.all([
			s.backups.publish(request),
			s.backups.publish(request),
		]);
		const record = expectOk(records[0]!);
		expect(expectOk(records[1]!)).toEqual(record);
		expect(expectOk(s.backups.list())).toEqual([record]);
		const unavailable = s.authority.backups({
			library: s.library,
			identity: s.identity,
			archives: {
				async put() {
					throw new Error('Committed retry must not write');
				},
				async get() {
					throw new Error('Committed retry must not read');
				},
			},
		});
		expect(expectOk(await unavailable.publish(request))).toEqual(record);
	} finally {
		s.database.close();
	}
});

test('publication snapshots request bytes and metadata before asynchronous hashing', async () => {
	const s = await setup();
	try {
		const bytes = new Uint8Array(s.request.bytes);
		const publishing = s.backups.publish(s.request);
		s.request.bytes.fill(0);
		s.request.metadata.source.head = 9;
		const record = expectOk(await publishing);
		expect(record.source.head).toBe(1);
		expect(expectOk(await s.backups.download(record.id))).toEqual(bytes);
	} finally {
		s.database.close();
	}
});

test('missing or corrupted objects refuse download without erasing the published record', async () => {
	const s = await setup();
	try {
		const record = expectOk(await s.backups.publish(s.request));
		const original = expectOk(await s.archives.get(record.id));
		for (const bytes of [
			undefined,
			new Blob(['corrupt'], { type: original.type }),
			new Blob([await original.arrayBuffer()], { type: 'text/plain' }),
		]) {
			const corrupted = s.authority.backups({
				library: s.library,
				identity: s.identity,
				archives: {
					put: s.archives.put,
					async get(id) {
						return bytes ? Ok(bytes) : BlobStoreError.BlobNotFound({ id });
					},
				},
			});
			expectErr(await corrupted.download(record.id));
			expect(expectOk(s.backups.list())).toEqual([record]);
		}
	} finally {
		s.database.close();
	}
});

test('private backup publication refuses a full key with a non-archive suffix', async () => {
	const s = await setup();
	try {
		expect(
			expectErr(
				await s.backups.publish({ ...s.request, id: generateBlobId('wav') }),
			).name,
		).toBe('BackupFailed');
		expect(expectOk(s.backups.list())).toEqual([]);
		expect(expectOk(await s.archives.list()).items).toEqual([]);
	} finally {
		s.database.close();
	}
});
