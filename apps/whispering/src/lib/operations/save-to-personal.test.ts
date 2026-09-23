import { expect, mock, test } from 'bun:test';
import { InstantString } from '@epicenter/app/field';
import { openMemory } from '@epicenter/app/memory';
import { generateBlobId } from '@epicenter/blobs';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { whisperingDefinition } from '../data.js';
import { createPendingSaves } from '../whispering/pending-saves.js';
import type { PersonalStore } from '../whispering/personal.js';
import { newRecordingValues } from '../whispering/recordings.js';
import { saveToPersonal } from './save-to-personal.js';

async function setup() {
	const local = await openMemory(whisperingDefinition);
	const personal = await openMemory(whisperingDefinition);
	const signal = new AbortController();
	const app = {
		signal: signal.signal,
		pendingSaves: createPendingSaves(signal.signal),
	};
	const row = local.tables.recordings.create({
		...newRecordingValues({
			audioBlobId: generateBlobId('wav'),
			recordedAt: InstantString.now(),
			recordedAtZone: 'UTC',
			duration: 10,
		}),
		title: 'before',
		transcript: 'original',
		transcriptionStatus: 'completed',
	});
	const destinationId = generateBlobId('wav');
	const copyFrom = mock(async () => Ok(destinationId));
	const localBlobs = {};
	mock.module('../whispering/local.js', () => ({
		local: { ...local, blobs: localBlobs },
	}));
	let blocked = false;
	const destination = {
		...personal,
		blobs: { copyFrom },
		persistence: {
			...personal.persistence,
			flush: () => personal.persistence.flush(),
			get: () => (blocked ? 'blocked' : personal.persistence.get()),
		},
	} as unknown as PersonalStore;
	return {
		local,
		personal,
		row,
		app,
		signal,
		copyFrom,
		localBlobs,
		destinationId,
		destination,
		block() {
			blocked = true;
		},
		unblock() {
			blocked = false;
		},
	};
}

test('copy captures declared scalar values before awaiting bytes and creates independent content and IDs', async () => {
	const f = await setup();
	await using local = f.local;
	await using personal = f.personal;
	const release = Promise.withResolvers<void>();
	f.copyFrom.mockImplementationOnce(async () => {
		await release.promise;
		return Ok(f.destinationId);
	});
	const saving = saveToPersonal(f.app, f.destination, f.row.id);
	local.tables.recordings.update(f.row.id, {
		title: 'after',
		transcript: 'edited',
	});
	release.resolve();
	const copied = expectOk(await saving);
	expect(copied.id).not.toBe(f.row.id);
	expect(copied.audioBlobId).toBe(f.destinationId);
	expect(copied.title).toBe('before');
	expect(copied.transcript).toBe('original');
	expect(personal.tables.recordings.body(copied.id)).not.toBe(
		local.tables.recordings.body(f.row.id),
	);
	expect(f.copyFrom).toHaveBeenCalledWith(f.localBlobs, f.row.audioBlobId, {
		signal: f.signal.signal,
	});
	personal.tables.recordings.delete(copied.id);
	expect(local.tables.recordings.get(f.row.id)?.title).toBe('after');
});

test('known bytes and row survive blocked persistence without another copy or create', async () => {
	const f = await setup();
	await using local = f.local;
	await using personal = f.personal;
	f.block();
	expectErr(await saveToPersonal(f.app, f.destination, f.row.id));
	const ids = personal.tables.recordings.ids();
	expect(ids).toHaveLength(1);
	local.tables.recordings.delete(f.row.id);
	f.unblock();
	await f.app.pendingSaves.entries[0]!.retry();
	expect(f.app.pendingSaves.entries).toHaveLength(0);
	expect(f.copyFrom).toHaveBeenCalledTimes(1);
	expect(personal.tables.recordings.ids()).toEqual(ids);
});

test('departure after copy retains the destination without publishing or resuming on another account', async () => {
	const f = await setup();
	await using local = f.local;
	await using personal = f.personal;
	f.copyFrom.mockImplementationOnce(async () => {
		f.signal.abort();
		return Ok(f.destinationId);
	});
	expectErr(await saveToPersonal(f.app, f.destination, f.row.id));
	expect(personal.tables.recordings.ids()).toHaveLength(0);
	expect(f.app.pendingSaves.entries).toHaveLength(1);
	await f.app.pendingSaves.entries[0]!.retry();
	expect(personal.tables.recordings.ids()).toHaveLength(0);
	expect(f.copyFrom).toHaveBeenCalledTimes(1);
});
