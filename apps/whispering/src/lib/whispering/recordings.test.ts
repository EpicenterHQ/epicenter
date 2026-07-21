/** Recordings domain tests over the real Bun @epicenter/data stack. */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type BlobRemote,
	type BlobStore,
	BlobStoreError,
	generateBlobId,
} from '@epicenter/blobs';
import { openBunEpicenter } from '@epicenter/data/bun';
import { InstantString } from '@epicenter/field';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	type Recording,
	type RecordingId,
	recordingsTable,
} from '../workspace';
import { createWhisperingRecordings } from './recordings';

function stubLocalStore(overrides: Partial<BlobStore> = {}): BlobStore {
	return {
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
		...overrides,
	};
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

function recording(overrides: Partial<Omit<Recording, 'id'>> = {}) {
	return {
		audioBlobId: generateBlobId(),
		uploadedAt: null,
		title: '',
		recordedAt: InstantString.now(),
		recordedAtZone: 'UTC',
		transcript: '',
		polishedTranscript: null,
		duration: null,
		transcription: null,
		...overrides,
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
	const root = mkdtempSync(join(tmpdir(), 'whispering-recordings-'));
	const epicenter = await openBunEpicenter({ directory: root });
	const table = epicenter.bind({
		tables: { recordings: recordingsTable },
		values: {},
	}).tables.recordings;
	for (const row of seed) await table.create(row);
	const domain = createWhisperingRecordings({
		table,
		blobs: { local, remote },
		reportBackgroundError: () => undefined,
	});
	await domain.ready;
	return {
		table,
		recordings: domain.recordings,
		async dispose() {
			domain.dispose();
			await epicenter[Symbol.asyncDispose]();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test('CRUD stays live and recording order is newest first', async () => {
	const context = await setup();
	try {
		const older = await context.recordings.create({
			...recording({
				recordedAt: InstantString.fromDate(
					new Date('2026-07-20T01:00:00.000Z'),
				),
			}),
		});
		const newer = await context.recordings.create({
			...recording({
				recordedAt: InstantString.fromDate(
					new Date('2026-07-20T02:00:00.000Z'),
				),
			}),
		});
		expect(context.recordings.sorted.map(({ id }) => id)).toEqual([
			newer.id,
			older.id,
		]);
		expectOk(await context.recordings.update(older.id, { title: 'updated' }));
		expect(context.recordings.get(older.id)?.title).toBe('updated');
		expectOk(await context.recordings.delete(newer.id));
		expect(context.recordings.get(newer.id)).toBeUndefined();
	} finally {
		await context.dispose();
	}
});

test('refresh loads and sorts every recording', async () => {
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
		const row = await context.recordings.create(recording());
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
		const row = await context.table.create(
			recording({ uploadedAt: InstantString.now() }),
		);
		await context.recordings.refresh();
		expectOk(await context.recordings.delete(row.id as RecordingId));
		order.push(
			expectOk(await context.table.get(row.id)) === undefined ? 'row' : 'live',
		);
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
		seed: [recording(), recording({ uploadedAt: InstantString.now() })],
	});
	try {
		const error = expectErr(
			await context.recordings.delete(
				context.recordings.sorted.map(({ id }) => id),
			),
		);
		expect(error.name).toBe('RemoteUnavailable');
		expect(localDeletes).toBe(0);
		expect(context.recordings.count).toBe(2);
	} finally {
		await context.dispose();
	}
});

test('failed row creation cleans up the already committed audio', async () => {
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
		await expect(
			context.recordings.create({ ...recording(), audioBlobId }),
		).rejects.toThrow();
		expect(deleted).toEqual([audioBlobId]);
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
