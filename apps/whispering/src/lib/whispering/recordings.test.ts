/** Recordings domain tests over the real Bun @epicenter/data stack. */
import { expect, test } from 'bun:test';
import {
	type BlobRemote,
	BlobRemoteError,
	type BlobStore,
	BlobStoreError,
	generateBlobId,
} from '@epicenter/blobs';
import { createBrowserBlobSources } from '@epicenter/blobs/browser';
import { InstantString } from '@epicenter/data/field';
import { openMemory } from '@epicenter/data/memory';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { type RecordingId, whisperingDefinition } from '../data';
import { asStoredBlobId, type NewRecording } from './recording';
import type { UnscopedAudio } from './recording-audio.js';
import { createWhisperingRecordings } from './recordings';

function stubLocalStore(overrides: Partial<BlobStore> = {}): BlobStore {
	const store: BlobStore = {
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

/** One recording as the table takes it: the branded audio id, re-widened. */
function storedRow(row: NewRecording) {
	return {
		...row,
		audioBlobId: asStoredBlobId(row.audioBlobId),
		uploadedAt: null,
		transcriptionStatus: 'pending',
		transcriptionCompletedAt: null,
		transcriptionError: null,
	};
}

async function setup({
	local = stubLocalStore(),
	remote = stubRemote(),
	seed = [],
	unscoped = null,
}: {
	local?: BlobStore;
	remote?: BlobRemote | null;
	seed?: ReturnType<typeof recording>[];
	unscoped?: UnscopedAudio | null;
} = {}) {
	const data = await openMemory(whisperingDefinition);
	const table = data.tables.recordings;
	for (const row of seed) table.create(storedRow(row));
	const domain = createWhisperingRecordings({
		table,
		blobs: {
			local,
			remote,
			sources: createBrowserBlobSources(local),
			unscoped,
		},
	});
	return {
		table,
		recordings: domain.recordings,
		async dispose() {
			domain[Symbol.dispose]();
			await data[Symbol.asyncDispose]();
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
		const row = expectOk(await context.recordings.create(recording()));
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
		const row = context.table.create({
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

test('deletion resolves uploaded metadata after the initial claim settles', async () => {
	const finishClaim = Promise.withResolvers<void>();
	const order: string[] = [];
	const context = await setup({
		seed: [recording()],
		unscoped: {
			async claim() {
				await finishClaim.promise;
				return Ok({
					claimed: 1,
					absent: 0,
					skipped: 0,
					unclaimed: { count: 0, bytes: 0 },
				});
			},
			summary: async () => Ok({ count: 0, bytes: 0 }),
			delete: async () => Ok(undefined),
		},
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
		const row = context.recordings.sorted[0]!;
		const deleting = context.recordings.delete(row.id);
		await Promise.resolve();
		expect(order).toEqual([]);
		expectOk(context.table.update(row.id, { uploadedAt: InstantString.now() }));
		finishClaim.resolve();
		expectOk(await deleting);
		expect(order).toEqual(['remote', 'local']);
		expect(context.recordings.get(row.id)).toBeUndefined();
	} finally {
		finishClaim.resolve();
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
		context.table.create(storedRow(recording()));
		context.table.create({
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

test('row creation admits a storage-valid opaque blob id', async () => {
	const deleted: string[] = [];
	const context = await setup({
		local: stubLocalStore({
			async delete(id) {
				deleted.push(id);
				return Ok(undefined);
			},
		}),
	});
	try {
		const audioBlobId = 'invalid' as ReturnType<typeof generateBlobId>;
		const created = expectOk(
			await context.recordings.create({ ...recording(), audioBlobId }),
		);
		expect(created.audioBlobId).toBe(audioBlobId);
		await Bun.sleep(1);
		expect(deleted).toEqual([]);
	} finally {
		await context.dispose();
	}
});

test('storeAudio does not expose an id after a failed local commit', async () => {
	const context = await setup({
		local: stubLocalStore({
			async put(id) {
				return BlobStoreError.BlobStoreFailed({
					id,
					cause: new Error('quota exceeded'),
				});
			},
		}),
	});
	try {
		expectErr(await context.recordings.storeAudio(new Blob(['audio'])));
	} finally {
		await context.dispose();
	}
});

test('backup sends what this device holds, counts what it does not, and coalesces kicks', async () => {
	const here = generateBlobId();
	const elsewhere = generateBlobId();
	const uploaded: string[] = [];
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
		seed: [
			recording({ audioBlobId: here }),
			recording({ audioBlobId: elsewhere }),
		],
	});
	try {
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
		expect(uploaded).toEqual([here]);
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
		expect(purged).toContain(target.audioBlobId);
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
		seed: ids.map((audioBlobId) => recording({ audioBlobId })),
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
		expectOk(await context.recordings.create(recording()));
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

test('backup waits for the initial claim before caching missing bytes', async () => {
	const finishClaim = Promise.withResolvers<void>();
	let local = false;
	let batches = 0;
	const context = await setup({
		unscoped: {
			claim: async () => {
				await finishClaim.promise;
				local = true;
				return Ok({
					claimed: 1,
					absent: 0,
					skipped: 0,
					unclaimed: { count: 0, bytes: 0 },
				});
			},
			summary: async () => Ok({ count: 0, bytes: 0 }),
			delete: async () => Ok(undefined),
		},
		local: stubLocalStore({
			statMany: async (ids) => {
				batches++;
				return ids.map((id) =>
					local
						? Ok({ size: 1, contentType: 'audio/wav' })
						: BlobStoreError.BlobNotFound({ id }),
				);
			},
		}),
		seed: [recording()],
	});
	try {
		const pass = context.recordings.backup.kick();
		await Promise.resolve();
		expect(batches).toBe(0);
		finishClaim.resolve();
		expect((await pass).uploaded).toBe(1);
		expect(batches).toBe(1);
	} finally {
		finishClaim.resolve();
		await context.dispose();
	}
});

test('manual upload and local removal wait for the initial claim', async () => {
	const finishClaim = Promise.withResolvers<void>();
	let uploads = 0;
	let deletes = 0;
	const context = await setup({
		seed: [recording(), recording()],
		unscoped: {
			async claim() {
				await finishClaim.promise;
				return Ok({
					claimed: 2,
					absent: 0,
					skipped: 0,
					unclaimed: { count: 0, bytes: 0 },
				});
			},
			summary: async () => Ok({ count: 0, bytes: 0 }),
			delete: async () => Ok(undefined),
		},
		local: stubLocalStore({
			async delete() {
				deletes++;
				return Ok(undefined);
			},
		}),
		remote: stubRemote({
			async upload() {
				uploads++;
				return Ok(undefined);
			},
		}),
	});
	try {
		const [toUpload, toRemove] = context.recordings.sorted;
		const uploading = context.recordings.uploadAudio(toUpload!.id);
		const removing = context.recordings.removeLocalAudio(toRemove!.id);
		await Promise.resolve();
		expect(uploads).toBe(0);
		expect(deletes).toBe(0);
		expectOk(
			context.table.update(toRemove!.id, { uploadedAt: InstantString.now() }),
		);
		finishClaim.resolve();
		expectOk(await uploading);
		expectOk(await removing);
		expect(uploads).toBe(2);
		expect(deletes).toBe(1);
	} finally {
		finishClaim.resolve();
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
	const missing = Array.from({ length: 40 }, () => generateBlobId());
	const localIds = [generateBlobId(), generateBlobId()];
	const seen: string[][] = [];
	const context = await setup({
		seed: [...localIds, ...missing].map((audioBlobId, index) =>
			recording({
				audioBlobId,
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
		expect((await context.recordings.backup.kick()).failed).toBe(2);
		expect((await context.recordings.backup.kick()).failed).toBe(2);
		expect(seen.map((ids) => ids.length)).toEqual([42, 2]);
		expect(seen[1]).toEqual(localIds);
	} finally {
		await context.dispose();
	}
});

test('failed row creation awaits cleanup and reports whether local bytes were removed', async () => {
	const cleanup = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const context = await setup({
		local: stubLocalStore({
			delete: async () => {
				started.resolve();
				await cleanup.promise;
				return Ok(undefined);
			},
		}),
	});
	await context.dispose();
	let settled = false;
	const creating = context.recordings.create(recording()).then((result) => {
		settled = true;
		return result;
	});
	await started.promise;
	expect(settled).toBe(false);
	cleanup.resolve();
	expect(expectErr(await creating)).toMatchObject({
		name: 'RowCreateFailed',
		cleanupError: null,
	});
});

test('failed row creation preserves a cleanup failure instead of claiming audio was removed', async () => {
	const context = await setup({
		local: stubLocalStore({
			delete: async (id) =>
				BlobStoreError.BlobStoreFailed({ id, cause: new Error('disk failed') }),
		}),
	});
	await context.dispose();
	const error = expectErr(await context.recordings.create(recording()));
	expect(error).toMatchObject({
		name: 'RowCreateFailed',
		cleanupError: { name: 'BlobStoreFailed' },
	});
	expect(error.message).toBe(
		'Could not create the recording or remove its local audio.',
	);
});
