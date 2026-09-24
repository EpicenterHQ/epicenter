/**
 * Recording rows reference independently saved app-local blobs.
 * Verifies CRUD, reference replacement, failed row creation, retained bytes after
 * deletion, and local playback/export after reopening the real Bun stores.
 */

import { Database } from 'bun:sqlite';
import { expect, mock, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openData } from '@epicenter/app/data';
import { InstantString } from '@epicenter/app/field';
import { BlobStoreError, generateBlobId } from '@epicenter/blobs';
import { createBrowserBlobSources } from '@epicenter/blobs/browser';
import { createBunBlobStore } from '@epicenter/blobs/bun';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { acquireLocalBlobs } from '../../../../../packages/app/src/blob-owner.js';
import { createBrowserRecording } from '../../../../../packages/app/src/recording/browser.js';
import { whisperingDefinition } from '../data';
import { recordingPublication } from '../operations/publish-recording.js';
import { saveAudioRecording } from '../operations/save-audio-recording.js';
import { createPendingSaves } from './pending-saves.js';
import type { NewRecording } from './recordings.js';
import {
	newRecordingValues,
	openRecordingAudio,
	readRecordingAudio,
	sortedRecordings,
	updateRecording,
} from './recordings.js';

function recording(overrides: Partial<NewRecording> = {}): NewRecording {
	return {
		audioBlobId: generateBlobId('wav'),
		recordedAt: InstantString.now(),
		recordedAtZone: 'UTC',
		duration: null,
		...overrides,
	};
}

async function setup(directory?: string) {
	const root =
		directory ?? (await mkdtemp(join(tmpdir(), 'whispering-local-blobs-')));
	const sqlite = new Database(join(root, 'rows.sqlite'));
	const local = createBunBlobStore({ directory: join(root, 'bytes') });
	const data = await openData(
		whisperingDefinition,
		createBunSqliteAdapter(sqlite),
	);
	const access = expectOk(
		await acquireLocalBlobs({
			assertUsable() {},
			id: whisperingDefinition.id,
			binding: {
				local,
				sources: createBrowserBlobSources(local),
				recording: createBrowserRecording,
			},
		}),
	);
	const signal = new AbortController().signal;
	const app = {
		local: { ...data, blobs: access.value },
		pendingSaves: createPendingSaves(signal),
		store: data,
		remoteBlobs: null,
		localBlobs: access.value,
		personal: undefined,
	};
	mock.module('./local.js', () => ({ local: app.local }));
	return {
		root,
		app,
		local,
		data,
		async close() {
			await access.close();
			try {
				await data[Symbol.asyncDispose]();
			} finally {
				sqlite.close();
			}
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
			await recordingPublicationForTest(
				f.data,
				recording({
					recordedAt: InstantString.fromDate(new Date('2026-07-20T01:00:00Z')),
				}),
			),
		);
		const newer = expectOk(
			await recordingPublicationForTest(
				f.data,
				recording({
					recordedAt: InstantString.fromDate(new Date('2026-07-20T02:00:00Z')),
				}),
			),
		);
		expect(sortedRecordings(f.data).map((row) => row.id)).toEqual([
			newer.id,
			older.id,
		]);
		const replacement = generateBlobId('wav');
		updateRecording(f.data, older.id, {
			title: 'updated',
			audioBlobId: replacement,
		});
		expect(f.data.tables.recordings.get(older.id)?.audioBlobId).toBe(
			replacement,
		);
		f.data.tables.recordings.delete(newer.id);
		expect(f.data.tables.recordings.get(newer.id)).toBeUndefined();
	} finally {
		await f.dispose();
	}
});

test('row creation and deletion never publish or delete bytes', async () => {
	const f = await setup();
	try {
		const blobId = expectOk(
			await f.app.localBlobs.add(new Blob(['saved audio'])),
		);
		const write = spyOn(f.local, 'put');
		const remove = spyOn(f.local, 'delete');
		const row = expectOk(
			await recordingPublicationForTest(
				f.data,
				recording({ audioBlobId: blobId }),
			),
		);
		expect(row.audioBlobId).toBe(blobId);
		expect(write).not.toHaveBeenCalled();
		f.data.tables.recordings.delete(row.id);
		expect(remove).not.toHaveBeenCalled();
		expect(await expectOk(await f.app.localBlobs.get(blobId)).text()).toBe(
			'saved audio',
		);
	} finally {
		await f.dispose();
	}
});

test('failed row creation reports the saved blob reference and leaves its bytes available', async () => {
	const f = await setup();
	try {
		const blobId = expectOk(await f.app.localBlobs.add(new Blob(['saved'])));
		const create = spyOn(f.data.tables.recordings, 'create').mockImplementation(
			() => {
				throw new Error('row failure');
			},
		);
		expect(
			expectErr(
				await recordingPublicationForTest(
					f.data,
					recording({ audioBlobId: blobId }),
				),
			).audioBlobId,
		).toBe(blobId);
		create.mockRestore();
		expect(f.data.tables.recordings.rows.length).toBe(0);
		expect(await expectOk(await f.app.localBlobs.get(blobId)).text()).toBe(
			'saved',
		);
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
			await f.app.localBlobs.add(new Blob([bytes], { type: 'audio/wav' })),
		);
		const row = expectOk(
			await recordingPublicationForTest(
				f.data,
				recording({ audioBlobId: blobId }),
			),
		);
		await f.close();
		f = await setup(directory);
		const playback = expectOk(
			await openRecordingAudio(
				f.app.local,
				f.data.tables.recordings.get(row.id)!,
			),
		);
		try {
			const played = await (await fetch(playback.url)).arrayBuffer();
			expect(Bun.hash(played)).toBe(Bun.hash(bytes));
		} finally {
			playback[Symbol.dispose]();
		}
		expect(
			Bun.hash(
				await expectOk(
					await readRecordingAudio(f.app.local, row.id),
				).arrayBuffer(),
			),
		).toBe(Bun.hash(bytes));
	} finally {
		await f.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test('Personal playback and reads resolve only the containing store ID', async () => {
	const f = await setup();
	try {
		const row = expectOk(
			await recordingPublicationForTest(f.data, recording()),
		);
		const opened: string[] = [];
		const personal = {
			tables: f.data.tables,
			blobs: {
				async open(id: string) {
					opened.push(id);
					return {
						data: {
							url: 'https://example.invalid/audio',
							[Symbol.dispose]() {},
						},
						error: null,
					} as const;
				},
				async get(id: string) {
					opened.push(id);
					return { data: new Blob(['personal']), error: null } as const;
				},
			},
		} as Pick<import('./app.js').RecordingStore, 'tables' | 'blobs'>;
		const source = expectOk(await openRecordingAudio(personal, row));
		source[Symbol.dispose]();
		expect(
			await expectOk(await readRecordingAudio(personal, row.id)).text(),
		).toBe('personal');
		expect(opened).toEqual([row.audioBlobId, row.audioBlobId]);
		expect(expectErr(await readRecordingAudio(f.app.local, row.id)).name).toBe(
			'BlobNotFound',
		);
	} finally {
		await f.dispose();
	}
});

for (const audio of [
	new File(['imported'], 'speech.WAV'),
	new Blob(['voice'], { type: 'audio/wav' }),
]) {
	test(`finished ${audio instanceof File ? 'import' : 'voice'} audio publishes once before row creation`, async () => {
		const f = await setup();
		const write = spyOn(f.local, 'put');
		try {
			const app = {
				...f.app,
				signal: new AbortController().signal,
			};
			const row = expectOk(await saveAudioRecording(app, audio));
			if (row === null) throw new Error('The live App must create a row');
			expect(row.audioBlobId).toEndWith('.wav');
			expect(write).toHaveBeenCalledTimes(1);
			expect(
				await expectOk(await f.app.localBlobs.get(row.audioBlobId)).text(),
			).toBe(await audio.text());
			expect(row).toMatchObject({
				title: '',
				duration: null,
			});
		} finally {
			write.mockRestore();
			await f.dispose();
		}
	});
}

test('failed imported row creation retains the one published blob and its key', async () => {
	const f = await setup();
	const create = spyOn(f.data.tables.recordings, 'create').mockImplementation(
		() => {
			throw new Error('row rejected');
		},
	);
	try {
		const app = {
			...f.app,
			signal: new AbortController().signal,
		};
		const failure = expectErr(
			await saveAudioRecording(app, new File(['retained'], 'speech.wav')),
		);
		expect(failure.name).toBe('Unconfirmed');
		if (!('audioBlobId' in failure))
			throw new Error('Expected saved-byte receipt');
		expect(
			await expectOk(
				await f.app.localBlobs.get(
					failure.audioBlobId as import('@epicenter/blobs').BlobId,
				),
			).text(),
		).toBe('retained');
		expect(
			expectOk(await f.app.localBlobs.list()).items.map((item) => item.id),
		).toEqual([failure.audioBlobId as import('@epicenter/blobs').BlobId]);
		expect(f.data.tables.recordings.rows.length).toBe(0);
	} finally {
		create.mockRestore();
		await f.dispose();
	}
});

test('retirement during publication retains bytes without writing a row', async () => {
	const f = await setup();
	const controller = new AbortController();
	const put = f.local.put;
	const write = spyOn(f.local, 'put').mockImplementation(async (...args) => {
		const saved = await put(...args);
		controller.abort(new Error('retired'));
		return saved;
	});
	try {
		const app = {
			...f.app,
			signal: controller.signal,
		};
		expect(
			expectOk(await saveAudioRecording(app, new Blob(['retained']))),
		).toBeNull();
		expect(f.data.tables.recordings.rows.length).toBe(0);
		expect(expectOk(await f.app.localBlobs.list()).items).toHaveLength(1);
	} finally {
		write.mockRestore();
		await f.dispose();
	}
});

test('publication failure creates no recording row', async () => {
	const f = await setup();
	const write = spyOn(f.local, 'put').mockImplementation(async (id) =>
		BlobStoreError.BlobStoreFailed({ id, cause: 'disk full' }),
	);
	try {
		const app = {
			...f.app,
			signal: new AbortController().signal,
		};
		expect(
			expectErr(await saveAudioRecording(app, new Blob(['audio']))).name,
		).toBe('BlobStoreFailed');
		expect(f.data.tables.recordings.rows.length).toBe(0);
		expect(expectOk(await f.app.localBlobs.list()).items).toEqual([]);
	} finally {
		write.mockRestore();
		await f.dispose();
	}
});

function recordingPublicationForTest(
	store: Parameters<typeof recordingPublication>[0],
	values: NewRecording,
) {
	return recordingPublication(
		store,
		newRecordingValues(values),
		new AbortController().signal,
	)();
}

test('uncertain Local byte publication retains its known ID and verifies it without another add', async () => {
	const f = await setup();
	try {
		const signal = new AbortController().signal;
		const pendingSaves = createPendingSaves(signal);
		let additions = 0;
		let knownId: ReturnType<typeof generateBlobId> | undefined;
		mock.module('./local.js', () => ({
			local: {
				...f.app.local,
				blobs: {
					...f.app.localBlobs,
					async add(audio: Blob) {
						additions++;
						knownId = expectOk(await f.app.localBlobs.add(audio));
						return BlobStoreError.BlobStoreFailed({
							id: knownId,
							cause: 'Lost durable confirmation',
						});
					},
				},
			},
		}));
		expectErr(
			await saveAudioRecording(
				{ signal, pendingSaves },
				new Blob(['retained bytes']),
			),
		);
		expect(f.data.tables.recordings.rows).toHaveLength(0);
		await pendingSaves.entries[0]!.retry();
		expect(additions).toBe(1);
		expect(f.data.tables.recordings.rows[0]?.audioBlobId).toBe(knownId);
		expect(pendingSaves.entries).toHaveLength(0);
	} finally {
		await f.dispose();
	}
});
