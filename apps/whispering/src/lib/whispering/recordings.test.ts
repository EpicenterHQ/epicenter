/**
 * Recording rows reference independently saved app-local blobs.
 * Verifies CRUD, reference replacement, failed row creation, retained bytes after
 * deletion, and local playback/export after reopening the real Bun stores.
 */
import { Database } from 'bun:sqlite';
import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStoreError, generateBlobId } from '@epicenter/blobs';
import { createAppBlobs } from '@epicenter/blobs/app';
import { createBrowserBlobSources } from '@epicenter/blobs/browser';
import { createBunBlobStore } from '@epicenter/blobs/bun';
import { openAccountStore } from '@epicenter/data/direct';
import { InstantString } from '@epicenter/data/field';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { whisperingDefinition } from '../data';
import type { NewRecording } from './recording';
import { createWhisperingRecordings } from './recordings';

function recording(overrides: Partial<NewRecording> = {}): NewRecording {
	return {
		audioBlobId: generateBlobId(),
		title: '',
		recordedAt: InstantString.now(),
		recordedAtZone: 'UTC',
		transcript: '',
		polishedTranscript: null,
		duration: null,
		...overrides,
	};
}

async function setup(directory?: string) {
	const root =
		directory ?? (await mkdtemp(join(tmpdir(), 'whispering-local-blobs-')));
	const sqlite = new Database(join(root, 'rows.sqlite'));
	const local = createBunBlobStore({ directory: join(root, 'bytes') });
	const data = await openAccountStore({
		definition: whisperingDefinition,
		sqlite: createBunSqliteAdapter(sqlite),
		dispose: () => sqlite.close(),
	});
	const access = createAppBlobs({
		local,
		sources: createBrowserBlobSources(local),
	});
	const app = { tables: data.tables, blobs: { local: access.value } };
	const domain = createWhisperingRecordings(app);
	return {
		root,
		app,
		local,
		data,
		recordings: domain.recordings,
		async close() {
			domain[Symbol.dispose]();
			await access.close();
			await data[Symbol.asyncDispose]();
		},
		async dispose() {
			await this.close();
			if (!directory) await rm(root, { recursive: true, force: true });
		},
	};
}

test('rows stay live, sort newest first, and allow replacing the blob reference', async () => {
	const f = await setup();
	try {
		const older = expectOk(
			await f.recordings.create(
				recording({
					recordedAt: InstantString.fromDate(new Date('2026-07-20T01:00:00Z')),
				}),
			),
		);
		const newer = expectOk(
			await f.recordings.create(
				recording({
					recordedAt: InstantString.fromDate(new Date('2026-07-20T02:00:00Z')),
				}),
			),
		);
		expect(f.recordings.sorted.map((row) => row.id)).toEqual([
			newer.id,
			older.id,
		]);
		const replacement = generateBlobId();
		f.recordings.patch(older.id, {
			title: 'updated',
			audioBlobId: replacement,
		});
		expect(f.recordings.get(older.id)?.audioBlobId).toBe(replacement);
		expectOk(await f.recordings.delete(newer.id));
		expect(f.recordings.get(newer.id)).toBeUndefined();
	} finally {
		await f.dispose();
	}
});

test('row creation and deletion never publish or delete bytes', async () => {
	const f = await setup();
	try {
		const blobId = expectOk(
			await f.app.blobs.local.add(new Blob(['saved audio'])),
		);
		const write = spyOn(f.local, 'put');
		const remove = spyOn(f.local, 'delete');
		const row = expectOk(
			await f.recordings.create(recording({ audioBlobId: blobId })),
		);
		expect(row.audioBlobId).toBe(blobId);
		expect(write).not.toHaveBeenCalled();
		expectOk(await f.recordings.delete(row.id));
		expect(remove).not.toHaveBeenCalled();
		expect(await expectOk(await f.app.blobs.local.get(blobId)).text()).toBe(
			'saved audio',
		);
	} finally {
		await f.dispose();
	}
});

test('failed row creation reports the saved blob reference and leaves its bytes available', async () => {
	const f = await setup();
	try {
		const blobId = expectOk(await f.app.blobs.local.add(new Blob(['saved'])));
		const create = spyOn(f.app.tables.recordings, 'create').mockImplementation(
			() => {
				throw new Error('row failure');
			},
		);
		expect(
			expectErr(await f.recordings.create(recording({ audioBlobId: blobId })))
				.audioBlobId,
		).toBe(blobId);
		create.mockRestore();
		expect(f.recordings.count).toBe(0);
		expect(await expectOk(await f.app.blobs.local.get(blobId)).text()).toBe(
			'saved',
		);
	} finally {
		await f.dispose();
	}
});

test('availability checks metadata without reading bytes or hiding storage failure', async () => {
	const f = await setup();
	try {
		const row = expectOk(await f.recordings.create(recording()));
		expect(expectOk(await f.recordings.audioAvailability(row.id))).toBe(
			'unavailable',
		);
		expectOk(await f.local.put(row.audioBlobId, new Blob(['saved'])));
		const get = spyOn(f.local, 'get');
		expect(expectOk(await f.recordings.audioAvailability(row.id))).toBe(
			'local-only',
		);
		expect(get).not.toHaveBeenCalled();
		const stat = spyOn(f.local, 'stat').mockImplementation(async (id) =>
			BlobStoreError.BlobStoreFailed({ id, cause: 'disk missing' }),
		);
		expect(expectErr(await f.recordings.audioAvailability(row.id)).name).toBe(
			'BlobStoreFailed',
		);
		stat.mockRestore();
	} finally {
		await f.dispose();
	}
});

test('saved audio reopens from disk for local playback and export', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'whispering-reopen-'));
	let f = await setup(directory);
	try {
		const bytes = new Uint8Array(17_280_044).fill(47);
		const blobId = expectOk(
			await f.app.blobs.local.add(new Blob([bytes], { type: 'audio/wav' })),
		);
		const row = expectOk(
			await f.recordings.create(recording({ audioBlobId: blobId })),
		);
		await f.close();
		f = await setup(directory);
		const playback = expectOk(await f.recordings.openAudio(row.id));
		try {
			const played = await (await fetch(playback.url)).arrayBuffer();
			expect(Bun.hash(played)).toBe(Bun.hash(bytes));
		} finally {
			playback[Symbol.dispose]();
		}
		expect(
			Bun.hash(
				await expectOk(await f.recordings.readAudio(row.id)).arrayBuffer(),
			),
		).toBe(Bun.hash(bytes));
	} finally {
		await f.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test('playback opens an explicit remote URL only when local audio is missing', async () => {
	const f = await setup();
	try {
		const row = expectOk(await f.recordings.create(recording()));
		const opened: string[] = [];
		Object.assign(f.app.blobs, {
			remote: {
				async get(url: string) {
					opened.push(url);
					return { data: new Blob(['remote']), error: null };
				},
				async open(url: string) {
					opened.push(url);
					return { data: { url, [Symbol.dispose]() {} }, error: null };
				},
			},
		});
		f.recordings.patch(row.id, { audioUrl: 'https://cloud.example/saved' });
		expect(expectOk(await f.recordings.audioAvailability(row.id))).toBe(
			'remote',
		);
		const source = expectOk(await f.recordings.openAudio(row.id));
		expect(source.url).toBe('https://cloud.example/saved');
		source[Symbol.dispose]();
		expect(opened).toEqual(['https://cloud.example/saved']);
		expect(await expectOk(await f.recordings.readAudio(row.id)).text()).toBe(
			'remote',
		);
		expectOk(await f.local.put(row.audioBlobId, new Blob(['local'])));
		const localSource = expectOk(await f.recordings.openAudio(row.id));
		expect(localSource.url.startsWith('blob:')).toBe(true);
		localSource[Symbol.dispose]();
		expect(opened).toHaveLength(2);
	} finally {
		await f.dispose();
	}
});
