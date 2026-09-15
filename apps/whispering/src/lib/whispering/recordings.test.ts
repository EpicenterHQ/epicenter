/**
 * Recordings domain tests over the real Bun data stack.
 * Verify finished-file saving, local reads after restart, conservative deletion,
 * and legacy local access without transfer or adoption.
 */

import { Database } from 'bun:sqlite';
import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppBlobs } from '@epicenter/app';
import {
	type BlobId,
	type BlobStat,
	type BlobStore,
	BlobStoreError,
	generateBlobId,
} from '@epicenter/blobs';
import { createBrowserBlobSources } from '@epicenter/blobs/browser';
import { createBunBlobStore } from '@epicenter/blobs/bun';
import { defineData, defineTable, field } from '@epicenter/data/definition';
import { openAccountStore, syncEngineOf } from '@epicenter/data/direct';
import { InstantString } from '@epicenter/data/field';
import { createMemoryRecord } from '@epicenter/data/memory';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { type RecordingId, whisperingDefinition } from '../data';
import { asRecording, type NewRecording } from './recording';
import { createWhisperingRecordings } from './recordings';

function stubLocalStore(overrides: Partial<BlobStore> = {}): BlobStore {
	const publications = new Map<BlobId, BlobStat>();
	const store: BlobStore = {
		async copy() {
			return Ok(undefined);
		},
		async put() {
			return Ok(undefined);
		},
		async get() {
			return Ok(new Blob());
		},
		async stat() {
			return Ok({ size: 0, contentType: 'audio/wav' });
		},
		async delete() {
			return Ok(undefined);
		},
		statMany(ids) {
			return Promise.all(ids.map((id) => store.stat(id)));
		},
		...overrides,
	};
	const stat = store.stat;
	store.stat = async (id) => {
		const result = await stat(id);
		if (result.error) return result;
		return Ok(publications.get(id) ?? result.data);
	};
	store.attachments = {
		async upload() {
			return Ok(undefined);
		},
		async download() {
			return Ok(undefined);
		},
		async put(id, file, originGeneration) {
			if (!(file instanceof Blob))
				return BlobStoreError.BlobStoreFailed({
					id,
					cause: 'Expected browser file',
				});
			const result = await store.put(id, file);
			if (result.error) return result;
			const hash = await crypto.subtle.digest(
				'SHA-256',
				await file.arrayBuffer(),
			);
			const content = {
				sha256: Buffer.from(hash).toString('hex'),
				size: file.size,
				contentType: file.type,
			};
			publications.set(id, {
				...content,
				attachment: {
					...content,
					originGeneration,
					pendingUpload: typeof originGeneration === 'number',
				},
			});
			return Ok(content);
		},
		async acknowledge() {
			return Ok(undefined);
		},
	};
	return store;
}

function appBlobs(local: BlobStore): AppBlobs {
	const sources = createBrowserBlobSources(local);
	return {
		async add(blob) {
			const id = generateBlobId();
			const result = await local.put(id, blob);
			return result.error === null ? Ok(id) : result;
		},
		get: (id) => local.get(id),
		stat: (id) => local.stat(id),
		statMany: (ids) => local.statMany(ids),
		open: (id) => sources.open(id),
		removeLocal: (id) => local.delete(id),
	};
}

function recording(overrides: Partial<NewRecording> = {}): NewRecording {
	return {
		audio: new Blob(['audio'], { type: 'audio/wav' }),
		title: '',
		recordedAt: InstantString.now(),
		recordedAtZone: 'UTC',
		transcript: '',
		polishedTranscript: null,
		duration: null,
		...overrides,
	};
}

/** One recording as the table takes it: the branded audio id, re-widened. */
function storedRow(row: NewRecording) {
	return {
		...row,
		audio: null,
		audioBlobId: generateBlobId(),
		uploadedAt: null as InstantString | null,
		transcriptionStatus: 'pending',
		transcriptionCompletedAt: null,
		transcriptionError: null,
	};
}

async function setup({
	local = stubLocalStore(),
	seed = [],
}: {
	local?: BlobStore;
	seed?: ReturnType<typeof recording>[];
} = {}) {
	const record = createMemoryRecord();
	const data = await openAccountStore({
		definition: whisperingDefinition,
		sqlite: record.sqlite,
		blobStore: local,
		dispose: record.close,
	});
	const table = data.tables.recordings;
	// Historical writers can still send existing rows. New callers cannot create
	// unfinished attachments through the current table contract.
	const historicalRecord = createMemoryRecord();
	const historical = await openAccountStore({
		definition: defineData({
			...whisperingDefinition,
			tables: {
				...whisperingDefinition.tables,
				recordings: defineTable({
					...whisperingDefinition.tables.recordings,
					audio: field.nullable(field.string()),
				}),
			},
		}),
		sqlite: historicalRecord.sqlite,
		dispose: historicalRecord.close,
	});
	function createLegacyFields(fields: ReturnType<typeof storedRow>) {
		const row = historical.tables.recordings.create(fields);
		expectOk(syncEngineOf(data).applyRemote(historical.encodeStateSince()));
		return table.get(row.id)!;
	}
	for (const row of seed) createLegacyFields(storedRow(row));
	const domain = createWhisperingRecordings({
		table,
		blobs: appBlobs(local),
	});
	return {
		table,
		createLegacyFields,
		createLegacy: (row: NewRecording) =>
			Ok(asRecording(createLegacyFields(storedRow(row)))),
		recordings: domain.recordings,
		async dispose() {
			domain[Symbol.dispose]();
			await data[Symbol.asyncDispose]();
			await historical[Symbol.asyncDispose]();
		},
	};
}

test('CRUD stays live and recording order is newest first', async () => {
	const context = await setup();
	try {
		const older = expectOk(
			await context.recordings.create(
				recording({
					recordedAt: InstantString.fromDate(
						new Date('2026-07-20T01:00:00.000Z'),
					),
				}),
			),
		);
		const newer = expectOk(
			await context.recordings.create(
				recording({
					recordedAt: InstantString.fromDate(
						new Date('2026-07-20T02:00:00.000Z'),
					),
				}),
			),
		);
		expect(context.recordings.sorted.map(({ id }) => id)).toEqual([
			newer.id,
			older.id,
		]);
		context.recordings.patch(older.id, { title: 'updated' });
		expect(context.recordings.get(older.id)?.title).toBe('updated');
		expectOk(await context.recordings.delete(newer.id));
		expect(context.recordings.get(newer.id)).toBeUndefined();
	} finally {
		await context.dispose();
	}
});

test('every seeded recording loads, newest first', async () => {
	const seed = Array.from({ length: 101 }, (_, index) =>
		recording({
			title: String(index),
			recordedAt: InstantString.fromDate(
				new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
			),
		}),
	);
	const context = await setup({ seed });
	try {
		expect(context.recordings.count).toBe(101);
		expect(context.recordings.sorted[0]?.title).toBe('100');
		expect(context.recordings.sorted.at(-1)?.title).toBe('0');
	} finally {
		await context.dispose();
	}
});

test('deletion removes the row without touching retained local bytes', async () => {
	const order: string[] = [];
	const context = await setup({
		local: stubLocalStore({
			async delete() {
				order.push('local');
				return Ok(undefined);
			},
		}),
	});
	try {
		const row = context.createLegacyFields({
			...storedRow(recording()),
			uploadedAt: InstantString.now(),
		});
		expectOk(await context.recordings.delete(row.id as RecordingId));
		order.push(context.table.get(row.id) === undefined ? 'row' : 'live');
		expect(order).toEqual(['row']);
	} finally {
		await context.dispose();
	}
});

test('deletion remains available offline for rows with historical upload markers', async () => {
	let localDeletes = 0;
	const context = await setup({
		local: stubLocalStore({
			async delete() {
				localDeletes += 1;
				return Ok(undefined);
			},
		}),
	});
	try {
		// Historical markers do not authorize deletion of retained bytes.
		context.createLegacyFields(storedRow(recording()));
		context.createLegacyFields({
			...storedRow(recording()),
			uploadedAt: InstantString.now(),
		});
		expectOk(
			await context.recordings.delete(
				context.recordings.sorted.map(({ id }) => id),
			),
		);
		expect(localDeletes).toBe(0);
		expect(context.recordings.count).toBe(0);
	} finally {
		await context.dispose();
	}
});

test('row creation completes its attachment without a public blob id', async () => {
	const context = await setup();
	try {
		const created = expectOk(await context.recordings.create(recording()));
		expect(created.audioBlobId).toBeNull();
		expect(created.audio).toBe('audio/wav');
		expect(
			await expectOk(await context.recordings.audioAvailability(created.id)),
		).toBe('local-only');
	} finally {
		await context.dispose();
	}
});

test('recording creation reports the owning table failure without a second cleanup path', async () => {
	const context = await setup({
		local: stubLocalStore({
			put: async (id) => {
				return BlobStoreError.BlobStoreFailed({
					id,
					cause: new Error('quota exceeded'),
				});
			},
		}),
	});
	try {
		expect(
			expectErr(await context.recordings.create(recording())),
		).toMatchObject({
			name: 'RowCreateFailed',
		});
	} finally {
		await context.dispose();
	}
});

test('reopening older recordings preserves their legacy read and update path without adopting bytes', async () => {
	const record = createMemoryRecord();
	const local = stubLocalStore();
	const { audio: _audio, ...legacyFields } =
		whisperingDefinition.tables.recordings;
	const legacy = defineData({
		...whisperingDefinition,
		tables: {
			...whisperingDefinition.tables,
			recordings: defineTable({ ...legacyFields, audioBlobId: field.blob() }),
		},
	});
	const old = await openAccountStore({
		definition: legacy,
		sqlite: record.sqlite,
		blobStore: local,
	});
	const { audio: _pending, ...fields } = storedRow(recording());
	const row = expectOk(
		await old.tables.recordings.create({
			...fields,
			audioBlobId: new Blob(['old audio']),
		}),
	);
	await old[Symbol.asyncDispose]();
	const opened = await openAccountStore({
		definition: whisperingDefinition,
		sqlite: record.sqlite,
		blobStore: local,
	});
	const domain = createWhisperingRecordings({
		table: opened.tables.recordings,
		blobs: appBlobs(local),
	});
	try {
		expect(domain.recordings.get(row.id)?.audioBlobId).toBe(row.audioBlobId);
		expect(domain.recordings.nonconforming).toEqual([]);
		expectOk(await domain.recordings.readAudio(row.id));
		domain.recordings.patch(row.id, { title: 'Still editable' });
		expect(domain.recordings.get(row.id)?.title).toBe('Still editable');
		expect(
			opened.tables.recordings.nonconforming[0]?.raw.audio,
		).toBeUndefined();
	} finally {
		domain[Symbol.dispose]();
		await opened[Symbol.asyncDispose]();
		record.close();
	}
});

test('failed finished-file save creates no row', async () => {
	const context = await setup({
		local: stubLocalStore({
			put: async (id) =>
				BlobStoreError.BlobStoreFailed({ id, cause: 'disk full' }),
		}),
	});
	try {
		expectErr(await context.recordings.create(recording()));
		expect(context.recordings.count).toBe(0);
	} finally {
		await context.dispose();
	}
});

test('availability checks metadata and preserves storage failures', async () => {
	let reads = 0;
	let failed = false;
	const context = await setup({
		local: stubLocalStore({
			get: async () => {
				reads++;
				return Ok(new Blob());
			},
			stat: async (id) =>
				failed
					? BlobStoreError.BlobStoreFailed({ id, cause: 'device unavailable' })
					: Ok({ size: 5, contentType: 'audio/wav' }),
		}),
	});
	try {
		const row = expectOk(await context.recordings.create(recording()));
		expect(expectOk(await context.recordings.audioAvailability(row.id))).toBe(
			'local-only',
		);
		expect(reads).toBe(0);
		failed = true;
		expect(
			expectErr(await context.recordings.audioAvailability(row.id)).name,
		).toBe('Failed');
	} finally {
		await context.dispose();
	}
});

for (const legacy of [false, true]) {
	test(`${legacy ? 'legacy' : 'attachment'} missing audio reads never invoke a remote transfer`, async () => {
		let missing = false;
		const context = await setup({
			local: stubLocalStore({
				stat: async (id) =>
					missing
						? BlobStoreError.BlobNotFound({ id })
						: Ok({ size: 0, contentType: 'audio/wav' }),
				get: async (id) => BlobStoreError.BlobNotFound({ id }),
			}),
		});
		const network = spyOn(globalThis, 'fetch').mockRejectedValue(
			new Error('Local reads must not fetch remote bytes.'),
		);
		try {
			const row = legacy
				? context.createLegacyFields({
						...storedRow(recording()),
						uploadedAt: InstantString.now(),
					})
				: expectOk(await context.recordings.create(recording()));
			const id = row.id as RecordingId;
			const marker = context.recordings.get(id)?.uploadedAt;
			missing = true;
			expect(expectOk(await context.recordings.audioAvailability(id))).toBe(
				'unavailable',
			);
			expectErr(await context.recordings.openAudio(id));
			expectErr(await context.recordings.readAudio(id));
			expect(network).not.toHaveBeenCalled();
			expect(context.recordings.get(id)?.uploadedAt).toBe(marker);
		} finally {
			network.mockRestore();
			await context.dispose();
		}
	});
}

test('finished imports reopen from disk and play or export locally through Whispering', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'whispering-finished-save-'));
	async function open() {
		const sqlite = new Database(join(directory, 'rows.sqlite'));
		const local = createBunBlobStore({ directory: join(directory, 'bytes') });
		const data = await openAccountStore({
			definition: whisperingDefinition,
			sqlite: createBunSqliteAdapter(sqlite),
			blobStore: local,
			dispose: () => sqlite.close(),
		});
		const domain = createWhisperingRecordings({
			table: data.tables.recordings,
			blobs: appBlobs(local),
		});
		return {
			data,
			recordings: domain.recordings,
			async close() {
				domain[Symbol.dispose]();
				await data[Symbol.asyncDispose]();
			},
		};
	}
	let current = await open();
	try {
		const saved: { id: RecordingId; size: number; digest: string }[] = [];
		for (const size of [96_044, 17_280_044]) {
			const bytes = new Uint8Array(size).fill(47);
			const audio = new Blob([bytes], { type: 'audio/wav' });
			const row = expectOk(
				await current.recordings.create(
					recording({ audio, duration: size === 96_044 ? 1_000 : 180_000 }),
				),
			);
			expect(current.data.persistence.get()).toBe('saved');
			expect(row.audioBlobId).toBeNull();
			saved.push({ id: row.id, size, digest: Bun.hash(bytes).toString() });
		}
		await current.close();
		current = await open();
		for (const row of saved) {
			expect(expectOk(await current.recordings.audioAvailability(row.id))).toBe(
				'local-only',
			);
			const playback = expectOk(await current.recordings.openAudio(row.id));
			try {
				const bytes = await (await fetch(playback.url)).arrayBuffer();
				expect(bytes.byteLength).toBe(row.size);
				expect(Bun.hash(bytes).toString()).toBe(row.digest);
			} finally {
				playback[Symbol.dispose]();
			}
			const exported = expectOk(await current.recordings.readAudio(row.id));
			expect(Bun.hash(await exported.arrayBuffer()).toString()).toBe(
				row.digest,
			);
		}
	} finally {
		await current.close();
		await rm(directory, { recursive: true, force: true });
	}
});
