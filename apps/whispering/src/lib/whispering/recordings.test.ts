/** Recordings domain tests over the real Bun @epicenter/data stack. */
import { expect, test } from 'bun:test';
import {
	type BlobRemote,
	type BlobStore,
	BlobStoreError,
	generateBlobId,
} from '@epicenter/blobs';
import { openMemory } from '@epicenter/data/memory';
import { InstantString } from '@epicenter/field';
import type { Result } from 'wellcrafted/result';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk as expectResult } from 'wellcrafted/testing';
import { type RecordingId, whisperingDefinition } from '../workspace';
import { asStoredBlobId, type NewRecording } from './recording';
import { createWhisperingRecordings } from './recordings';

function expectOk<TValue, TError>(
	result: Result<TValue, TError> | TValue,
): TValue {
	if (
		typeof result === 'object' &&
		result !== null &&
		'data' in result &&
		'error' in result
	) {
		return expectResult(result as Result<TValue, TError>);
	}
	return result as TValue;
}

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
}: {
	local?: BlobStore;
	remote?: BlobRemote | null;
	seed?: ReturnType<typeof recording>[];
} = {}) {
	const data = await openMemory(whisperingDefinition);
	const table = data.tables.recordings;
	for (const row of seed) expectOk(table.create(storedRow(row)));
	const domain = createWhisperingRecordings({
		table,
		blobs: { local, remote },
	});
	return {
		table,
		recordings: domain.recordings,
		async dispose() {
			domain[Symbol.dispose]();
			await data.store[Symbol.asyncDispose]();
		},
	};
}

test('CRUD stays live and recording order is newest first', async () => {
	const context = await setup();
	try {
		const older = context.recordings.create(
			recording({
				recordedAt: InstantString.fromDate(
					new Date('2026-07-20T01:00:00.000Z'),
				),
			}),
		);
		const newer = context.recordings.create(
			recording({
				recordedAt: InstantString.fromDate(
					new Date('2026-07-20T02:00:00.000Z'),
				),
			}),
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
		const row = context.recordings.create(recording());
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
		const row = expectOk(
			context.table.create({
				...storedRow(recording()),
				uploadedAt: InstantString.now(),
			}),
		);
		expectOk(await context.recordings.delete(row.id as RecordingId));
		order.push(
			expectOk(context.table.get(row.id)) === undefined ? 'row' : 'live',
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
	});
	try {
		// One local-only recording and one with an online copy. `uploadedAt` is
		// written through the table rather than the domain, because the audio
		// workflows are its only writer and there is no remote to upload to here.
		expectOk(context.table.create(storedRow(recording())));
		expectOk(
			context.table.create({
				...storedRow(recording()),
				uploadedAt: InstantString.now(),
			}),
		);
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
		const created = context.recordings.create({ ...recording(), audioBlobId });
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
