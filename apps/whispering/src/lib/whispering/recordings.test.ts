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
import { openData } from '@epicenter/app/data';
import { InstantString } from '@epicenter/app/field';
import { BlobStoreError, generateBlobId } from '@epicenter/blobs';
import { createAppBlobs } from '@epicenter/blobs/app';
import { createBrowserBlobSources } from '@epicenter/blobs/browser';
import { createBunBlobStore } from '@epicenter/blobs/bun';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { whisperingDefinition } from '../data';
import { saveAudioRecording } from '../operations/save-audio-recording.js';
import type { NewRecording } from './recordings.js';
import {
	createRecording,
	updateRecording,
	readRecordingAudio,
	openRecordingAudio,
	recordingAudioAvailability,
	sortedRecordings,
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
	const access = createAppBlobs({
		local,
		sources: createBrowserBlobSources(local),
	});
	const app = {
		library: data,
		blobs: { remote: null, local: access.value },
	};
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
			createRecording(
				f.data,
				recording({
					recordedAt: InstantString.fromDate(new Date('2026-07-20T01:00:00Z')),
				}),
			),
		);
		const newer = expectOk(
			createRecording(
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
			await f.app.blobs.local.add(new Blob(['saved audio'])),
		);
		const write = spyOn(f.local, 'put');
		const remove = spyOn(f.local, 'delete');
		const row = expectOk(
			createRecording(f.data, recording({ audioBlobId: blobId })),
		);
		expect(row.audioBlobId).toBe(blobId);
		expect(write).not.toHaveBeenCalled();
		f.data.tables.recordings.delete(row.id);
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
		const create = spyOn(f.data.tables.recordings, 'create').mockImplementation(
			() => {
				throw new Error('row failure');
			},
		);
		expect(
			expectErr(createRecording(f.data, recording({ audioBlobId: blobId })))
				.audioBlobId,
		).toBe(blobId);
		create.mockRestore();
		expect(f.data.tables.recordings.rows.length).toBe(0);
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
		const row = expectOk(createRecording(f.data, recording()));
		expect(expectOk(await recordingAudioAvailability(f.app, row.id))).toBe(
			'unavailable',
		);
		expectOk(await f.local.put(row.audioBlobId, new Blob(['saved'])));
		const get = spyOn(f.local, 'get');
		expect(expectOk(await recordingAudioAvailability(f.app, row.id))).toBe(
			'local',
		);
		expect(get).not.toHaveBeenCalled();
		const stat = spyOn(f.local, 'stat').mockImplementation(async (id) =>
			BlobStoreError.BlobStoreFailed({ id, cause: 'disk missing' }),
		);
		expect(
			expectErr(await recordingAudioAvailability(f.app, row.id)).name,
		).toBe('BlobStoreFailed');
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
			createRecording(f.data, recording({ audioBlobId: blobId })),
		);
		await f.close();
		f = await setup(directory);
		const playback = expectOk(
			await openRecordingAudio(
				f.app.blobs,
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
				await expectOk(await readRecordingAudio(f.app, row.id)).arrayBuffer(),
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
		const row = expectOk(createRecording(f.data, recording()));
		updateRecording(f.data, row.id, {
			audioUrl: 'https://cloud.example/saved',
		});
		expect(expectOk(await recordingAudioAvailability(f.app, row.id))).toBe(
			'unavailable',
		);
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
		updateRecording(f.data, row.id, {
			audioUrl: 'https://cloud.example/saved',
		});
		expect(expectOk(await recordingAudioAvailability(f.app, row.id))).toBe(
			'remote',
		);
		const source = expectOk(
			await openRecordingAudio(
				f.app.blobs,
				f.data.tables.recordings.get(row.id)!,
			),
		);
		expect(source.url).toBe('https://cloud.example/saved');
		source[Symbol.dispose]();
		expect(opened).toEqual(['https://cloud.example/saved']);
		expect(await expectOk(await readRecordingAudio(f.app, row.id)).text()).toBe(
			'remote',
		);
		expectOk(await f.local.put(row.audioBlobId, new Blob(['local'])));
		const localSource = expectOk(
			await openRecordingAudio(
				f.app.blobs,
				f.data.tables.recordings.get(row.id)!,
			),
		);
		expect(localSource.url.startsWith('blob:')).toBe(true);
		localSource[Symbol.dispose]();
		expect(opened).toHaveLength(2);
		expect(expectOk(await recordingAudioAvailability(f.app, row.id))).toBe(
			'local',
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
				await expectOk(await f.app.blobs.local.get(row.audioBlobId)).text(),
			).toBe(await audio.text());
			expect(row).toMatchObject({
				title: '',
				transcript: '',
				polishedTranscript: null,
				audioUrl: null,
				transcriptionStatus: 'pending',
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
		expect(failure.name).toBe('RowCreateFailed');
		if (failure.name !== 'RowCreateFailed')
			throw new Error('Expected saved-byte receipt');
		expect(
			await expectOk(await f.app.blobs.local.get(failure.audioBlobId)).text(),
		).toBe('retained');
		expect(
			expectOk(await f.app.blobs.local.list()).items.map((item) => item.id),
		).toEqual([failure.audioBlobId]);
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
		expect(expectOk(await f.app.blobs.local.list()).items).toHaveLength(1);
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
		expect(expectOk(await f.app.blobs.local.list()).items).toEqual([]);
	} finally {
		write.mockRestore();
		await f.dispose();
	}
});
