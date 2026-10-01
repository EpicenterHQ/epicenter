/** Recording publication retains one row and its bytes across blocked durability,
 * missing/nonconforming rows, and product departure. These are isolated store tests.
 */
import { expect, test } from 'bun:test';
import { InstantString } from '@epicenter/app/field';
import { openMemory } from '@epicenter/app/memory';
import { generateBlobId } from '@epicenter/blobs';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { whisperingDefinition } from '../data.js';
import { createPendingSaves } from '../whispering/pending-saves.js';
import { newRecordingValues } from '../whispering/recordings.js';
import { recordingPublication } from './publish-recording.js';

async function setup() {
	const store = await openMemory(whisperingDefinition);
	const departure = new AbortController();
	let blocked = true;
	const destination = {
		tables: store.tables,
		persistence: {
			...store.persistence,
			async flush() {
				if (!blocked) await store.persistence.flush();
			},
			get() {
				return blocked ? ('blocked' as const) : store.persistence.get();
			},
		},
	};
	const values = newRecordingValues({
		audioBlobId: generateBlobId('wav'),
		recordedAt: InstantString.now(),
		recordedAtZone: 'UTC',
		duration: 1234,
	});
	return {
		store,
		destination,
		values,
		departure,
		unblock() {
			blocked = false;
		},
	};
}

test('Finish saving retries retained persistence debt without minting a second row', async () => {
	const f = await setup();
	await using store = f.store;
	const saves = createPendingSaves(f.departure.signal);
	const receipt = saves.reserve('Local recording');
	expectErr(
		await receipt.run(
			recordingPublication(f.destination, f.values, f.departure.signal),
		),
	);
	const [id] = store.tables.recordings.ids();
	expect(saves.entries).toHaveLength(1);
	f.unblock();
	await saves.entries[0]!.retry();
	expect(saves.entries).toHaveLength(0);
	expect(store.tables.recordings.ids()).toEqual([id!]);
	expect(store.tables.recordings.get(id!)?.duration).toBe(1234);
});

test('a known nonconforming or deleted row is never recreated', async () => {
	const f = await setup();
	await using store = f.store;
	const save = recordingPublication(
		f.destination,
		f.values,
		f.departure.signal,
	);
	expectErr(await save());
	const [id] = store.tables.recordings.ids();
	store.tables.recordings.delete(id!);
	f.unblock();
	expectErr(await save());
	expect(store.tables.recordings.ids()).toEqual([]);
});

test('departure after flush retains known completion but cannot report success or retry on another account', async () => {
	const f = await setup();
	await using store = f.store;
	f.destination.persistence.flush = async () => {
		await store.persistence.flush();
		f.departure.abort();
	};
	const save = recordingPublication(
		f.destination,
		f.values,
		f.departure.signal,
	);
	const error = expectErr(await save());
	expect(error.rowId).toBe(store.tables.recordings.ids()[0]);
	expectErr(await save());
	expect(store.tables.recordings.ids()).toHaveLength(1);
});

test('a throw after creation never causes a second create with an unknown ID', async () => {
	const f = await setup();
	await using store = f.store;
	const create = store.tables.recordings.create;
	const destination = {
		...f.destination,
		tables: {
			...store.tables,
			recordings: {
				...store.tables.recordings,
				create(values: Parameters<typeof create>[0]) {
					create(values);
					throw new Error('lost return');
				},
			},
		},
	};
	const save = recordingPublication(destination, f.values, f.departure.signal);
	expectErr(await save());
	expectErr(await save());
	expect(store.tables.recordings.ids()).toHaveLength(1);
});

test('saved means flush and saved status, not only synchronous acceptance', async () => {
	const f = await setup();
	await using store = f.store;
	f.unblock();
	const row = expectOk(
		await recordingPublication(f.destination, f.values, f.departure.signal)(),
	);
	expect(store.persistence.get()).toBe('saved');
	expect(row.audioBlobId).toBe(f.values.audioBlobId);
});
