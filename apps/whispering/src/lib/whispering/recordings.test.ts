/** Recordings domain tests over the real Bun @epicenter/data stack. */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type BlobRemote,
	type BlobId,
	BlobRemoteError,
	type BlobStore,
	type BlobStat,
	BlobStoreError,
	generateBlobId,
} from '@epicenter/blobs';
import type { AppBlobs } from '@epicenter/app';
import { createBrowserBlobSources } from '@epicenter/blobs/browser';
import { createBunBlobStore } from '@epicenter/blobs/bun';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { InstantString } from '@epicenter/data/field';
import { defineData, defineTable, field } from '@epicenter/data/definition';
import { createMemoryRecord } from '@epicenter/data/memory';
import { openAccountStore, syncEngineOf } from '@epicenter/data/direct';
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

function stubRemote(overrides: Partial<BlobRemote> = {}): BlobRemote {
	return {
		async upload() {
			return Ok(undefined);
		},
		async download() {
			return Ok(undefined);
		},
		async purge() {
			return Ok(undefined);
		},
		...overrides,
	};
}

function appBlobs(local: BlobStore, remote: BlobRemote | null): AppBlobs {
	const sources = createBrowserBlobSources(local);
	return {
		remote: remote ?? {
			upload: async () => BlobRemoteError.RemoteNotConfigured(),
			download: async () => BlobRemoteError.RemoteNotConfigured(),
			purge: async () => BlobRemoteError.RemoteNotConfigured(),
		},
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
	remote = stubRemote(),
	seed = [],
}: {
	local?: BlobStore;
	remote?: BlobRemote | null;
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
		blobs: appBlobs(local, remote),
		remoteConfigured: remote !== null,
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

test('upload writes uploadedAt only after the remote copy succeeds', async () => {
	let uploaded = false;
	const context = await setup({
		remote: stubRemote({
			async upload() {
				uploaded = true;
				return Ok(undefined);
			},
		}),
	});
	try {
		const row = expectOk(context.createLegacy(recording()));
		expectOk(await context.recordings.uploadAudio(row.id));
		expect(uploaded).toBe(true);
		expect(context.recordings.get(row.id)?.uploadedAt).not.toBeNull();
	} finally {
		await context.dispose();
	}
});

test('deletion removes remote, local, then row', async () => {
	const order: string[] = [];
	const context = await setup({
		local: stubLocalStore({
			async delete() {
				order.push('local');
				return Ok(undefined);
			},
		}),
		remote: stubRemote({
			async purge() {
				order.push('remote');
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
		expect(order).toEqual(['remote', 'local', 'row']);
	} finally {
		await context.dispose();
	}
});

test('deletion preflights remote availability for the whole selection', async () => {
	let localDeletes = 0;
	const context = await setup({
		remote: null,
		local: stubLocalStore({
			async delete() {
				localDeletes += 1;
				return Ok(undefined);
			},
		}),
	});
	try {
		// One local-only recording and one with an online copy. `uploadedAt` is
		// written through the table rather than the domain, because the audio
		// workflows are its only writer and there is no remote to upload to here.
		context.createLegacyFields(storedRow(recording()));
		context.createLegacyFields({
			...storedRow(recording()),
			uploadedAt: InstantString.now(),
		});
		const error = expectErr(
			await context.recordings.delete(
				context.recordings.sorted.map(({ id }) => id),
			),
		);
		expect(error.name).toBe('RemoteUnavailable');
		// Nothing is deleted: the whole selection is preflighted first, so one
		// unreachable online copy stops the batch before any local byte goes.
		expect(localDeletes).toBe(0);
		expect(context.recordings.count).toBe(2);
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

test('backup sends what this device holds, counts what it does not, and coalesces kicks', async () => {
	const uploaded: string[] = [];
	let elsewhere = '';
	const context = await setup({
		local: stubLocalStore({
			async stat(id) {
				return id === elsewhere
					? BlobStoreError.BlobNotFound({ id })
					: Ok({ size: 1, contentType: 'audio/wav' });
			},
		}),
		remote: stubRemote({
			async upload(id) {
				uploaded.push(id);
				return Ok(undefined);
			},
		}),
		seed: [recording(), recording()],
	});
	try {
		const [here, missing] = context.recordings.sorted;
		if (here === undefined || missing === undefined)
			throw new Error('seeded two recordings');
		elsewhere = missing.audioBlobId!;
		expect(context.recordings.backup.pending).toBe(2);

		// Two kicks at once are one pass followed by one more, and both callers
		// get the answer that includes the second pass.
		const [first, second] = await Promise.all([
			context.recordings.backup.kick(),
			context.recordings.backup.kick(),
		]);
		expect(first).toBe(second);
		expect(first).toEqual({
			uploaded: 1,
			absent: 1,
			failed: 0,
			aborted: false,
		});
		expect(uploaded).toEqual([here.audioBlobId!]);
		expect(context.recordings.backup.pending).toBe(1);
	} finally {
		await context.dispose();
	}
});

test('backup stops after two consecutive failures and when the remote is unavailable', async () => {
	let attempts = 0;
	const failing = await setup({
		remote: stubRemote({
			async upload(id) {
				attempts += 1;
				return BlobRemoteError.BlobRemoteFailed({
					id,
					cause: new Error('offline'),
				});
			},
		}),
		seed: [recording(), recording(), recording()],
	});
	try {
		expect(await failing.recordings.backup.kick()).toEqual({
			uploaded: 0,
			absent: 0,
			failed: 2,
			aborted: true,
		});
		expect(attempts).toBe(2);
		expect(failing.recordings.backup.pending).toBe(3);
	} finally {
		await failing.dispose();
	}

	const signedOut = await setup({
		remote: null,
		seed: [recording(), recording()],
	});
	try {
		expect(await signedOut.recordings.backup.kick()).toEqual({
			uploaded: 0,
			absent: 0,
			failed: 0,
			aborted: true,
		});
	} finally {
		await signedOut.dispose();
	}
});

test('a recording deleted mid-pass is not reported as backed up, and its online copy is purged', async () => {
	const purged: string[] = [];
	let releaseUpload!: () => void;
	const uploadStarted = new Promise<void>((resolve) => {
		releaseUpload = resolve;
	});
	let finishUpload!: () => void;
	const uploadFinishes = new Promise<void>((resolve) => {
		finishUpload = resolve;
	});
	const context = await setup({
		remote: stubRemote({
			async upload() {
				releaseUpload();
				await uploadFinishes;
				return Ok(undefined);
			},
			async purge(id) {
				purged.push(id);
				return Ok(undefined);
			},
		}),
		seed: [recording()],
	});
	try {
		const [target] = context.recordings.sorted;
		if (target === undefined) throw new Error('seeded one recording');
		const pass = context.recordings.backup.kick();
		await uploadStarted;
		expectOk(await context.recordings.delete(target.id));
		finishUpload();
		const report = await pass;
		expect(report.uploaded).toBe(0);
		expect(report.failed).toBe(1);
		expect(purged).toContain(target.audioBlobId!);
		expect(context.recordings.backup.pending).toBe(0);
	} finally {
		await context.dispose();
	}
});

test('automatic kicks batch discovery once and remember missing bytes for the session', async () => {
	const ids = Array.from({ length: 100 }, () => generateBlobId());
	let batches = 0;
	const context = await setup({
		local: stubLocalStore({
			statMany: async (requested) => {
				batches++;
				return requested.map((id) => BlobStoreError.BlobNotFound({ id }));
			},
		}),
		seed: ids.map((id) => recording({ audio: new Blob([id]) })),
	});
	try {
		expect(context.recordings.backup.pending).toBe(100);
		expect(batches).toBe(0);
		expect((await context.recordings.backup.kick()).absent).toBe(100);
		expect((await context.recordings.backup.kick()).absent).toBe(100);
		expect(batches).toBe(1);
		await context.recordings.backup.kick({ refreshLocal: true });
		expect(batches).toBe(2);
	} finally {
		await context.dispose();
	}
});

test('storage failures remain retryable and an unavailable remote does no discovery', async () => {
	let batches = 0;
	const local = stubLocalStore({
		statMany: async (ids) => {
			batches++;
			return ids.map((id) =>
				BlobStoreError.BlobStoreFailed({ id, cause: new Error('disk failed') }),
			);
		},
	});
	const context = await setup({ local, seed: [recording()] });
	try {
		expect((await context.recordings.backup.kick()).failed).toBe(1);
		expect((await context.recordings.backup.kick()).failed).toBe(1);
		expect(batches).toBe(2);
	} finally {
		await context.dispose();
	}
	const offline = await setup({ local, remote: null, seed: [recording()] });
	try {
		expect((await offline.recordings.backup.kick()).aborted).toBe(true);
		expect(batches).toBe(2);
	} finally {
		await offline.dispose();
	}
});

test('new rows during a suspended upload join the same flight and its report', async () => {
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	let active = 0;
	let maximum = 0;
	let uploads = 0;
	const context = await setup({
		remote: stubRemote({
			upload: async () => {
				maximum = Math.max(maximum, ++active);
				if (uploads++ === 0) {
					started.resolve();
					await finish.promise;
				}
				active--;
				return Ok(undefined);
			},
		}),
		seed: [recording()],
	});
	try {
		const first = context.recordings.backup.kick();
		await started.promise;
		expectOk(context.createLegacy(recording()));
		const second = context.recordings.backup.kick();
		expect(second).toBe(first);
		finish.resolve();
		expect((await first).uploaded).toBe(2);
		expect(maximum).toBe(1);
		expect(context.recordings.backup.pending).toBe(0);
	} finally {
		finish.resolve();
		await context.dispose();
	}
});

test('a manual kick during discovery invalidates its old missing-byte result', async () => {
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	let batches = 0;
	const context = await setup({
		local: stubLocalStore({
			statMany: async (ids) => {
				if (++batches === 1) {
					started.resolve();
					await finish.promise;
					return ids.map((id) => BlobStoreError.BlobNotFound({ id }));
				}
				return ids.map(() => Ok({ size: 1, contentType: 'audio/wav' }));
			},
		}),
		seed: [recording()],
	});
	try {
		const first = context.recordings.backup.kick();
		await started.promise;
		const clicked = context.recordings.backup.kick({ refreshLocal: true });
		finish.resolve();
		expect(await first).toEqual({
			uploaded: 1,
			absent: 0,
			failed: 0,
			aborted: false,
		});
		expect(await clicked).toEqual(await first);
		expect(batches).toBe(2);
	} finally {
		finish.resolve();
		await context.dispose();
	}
});

test('disposing during discovery prevents uploads and coalesced work', async () => {
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	let uploads = 0;
	let batches = 0;
	const context = await setup({
		local: stubLocalStore({
			statMany: async (ids) => {
				batches++;
				started.resolve();
				await finish.promise;
				return ids.map(() => Ok({ size: 1, contentType: 'audio/wav' }));
			},
		}),
		remote: stubRemote({
			upload: async () => {
				uploads++;
				return Ok(undefined);
			},
		}),
		seed: [recording(), recording()],
	});
	const first = context.recordings.backup.kick();
	await started.promise;
	const second = context.recordings.backup.kick();
	await context.dispose();
	finish.resolve();
	expect((await first).aborted).toBe(true);
	await second;
	expect(uploads).toBe(0);
	expect(batches).toBe(1);
});

test('early upload failures do not discard missing-byte discoveries later in the batch', async () => {
	let missing: string[] = [];
	let localIds: string[] = [];
	const seen: string[][] = [];
	const context = await setup({
		seed: Array.from({ length: 42 }, (_, index) =>
			recording({
				recordedAt: InstantString.fromDate(
					new Date(Date.now() - index * 1_000),
				),
			}),
		),
		local: stubLocalStore({
			statMany: async (ids) => {
				seen.push([...ids]);
				return ids.map((id) =>
					missing.includes(id)
						? BlobStoreError.BlobNotFound({ id })
						: Ok({ size: 1, contentType: 'audio/wav' }),
				);
			},
		}),
		remote: stubRemote({
			upload: async (id) =>
				BlobRemoteError.BlobRemoteFailed({ id, cause: new Error('offline') }),
		}),
	});
	try {
		const ids = context.recordings.sorted.map(
			({ audioBlobId }) => audioBlobId!,
		);
		localIds = ids.slice(0, 2);
		missing = ids.slice(2);
		expect((await context.recordings.backup.kick()).failed).toBe(2);
		expect((await context.recordings.backup.kick()).failed).toBe(2);
		expect(seen.map((ids) => ids.length)).toEqual([42, 2]);
		expect(seen[1]).toEqual(localIds);
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
		blobs: appBlobs(local, null),
		remoteConfigured: false,
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

test('failed finished-file save creates no row or legacy backup work', async () => {
	const context = await setup({
		local: stubLocalStore({
			put: async (id) =>
				BlobStoreError.BlobStoreFailed({ id, cause: 'disk full' }),
		}),
	});
	try {
		expectErr(await context.recordings.create(recording()));
		expect(context.recordings.count).toBe(0);
		expect(context.recordings.backup.pending).toBe(0);
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
			blobs: appBlobs(local, null),
			remoteConfigured: false,
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
			expect(current.recordings.backup.pending).toBe(0);
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
