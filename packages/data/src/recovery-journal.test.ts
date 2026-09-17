/**
 * The client-side intent record: exact bytes across a lifetime that is gone,
 * one slot, a torn pair that never reads as an intent, and an address that
 * cannot be confused with another library's.
 *
 * The filesystem storage is what proves restart; `fake-indexeddb` supplies the
 * browser engine, where the claim under test is that the journal is a separate
 * database from the replica cache that a restore invalidates.
 */
import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBlobId } from '@epicenter/blobs';
import { expectOk } from 'wellcrafted/testing';
import {
	createRecoveryJournal,
	type PublicationIntent,
	recoveryJournalAddress,
} from './recovery-journal.js';
import { createFileJournalStorage } from './recovery-journal.test-support.js';
import { openCurrentCache } from './store/current-cache.js';
import { openIdbJournalStorage } from './store/idb-journal.js';

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

const metadata = {
	appId: 'so.epicenter.notes',
	dataId: 'so.epicenter.notes',
	version: 3,
	source: { generation: 3, head: 11 },
};

async function directory() {
	const path = await mkdtemp(join(tmpdir(), 'recovery-journal-'));
	directories.push(path);
	return path;
}

test('a publication intent returns its exact bytes to a journal that never wrote them', async () => {
	const path = await directory();
	const intent: PublicationIntent = {
		kind: 'publication',
		id: generateBlobId('json'),
		reason: 'manual',
		metadata,
		// Whitespace and all: an imported file is republished byte for byte.
		bytes: new TextEncoder().encode('\n{ "body": 1 }\n'),
	};
	expectOk(
		await createRecoveryJournal(createFileJournalStorage(path)).record(intent),
	);
	const restarted = createRecoveryJournal(createFileJournalStorage(path));
	expect(expectOk(await restarted.load())).toEqual(intent);
	expectOk(await restarted.clear());
	expect(
		expectOk(
			await createRecoveryJournal(createFileJournalStorage(path)).load(),
		),
	).toBeUndefined();
});

test('one slot: recording another intent replaces the one it resolves', async () => {
	const path = await directory();
	const journal = createRecoveryJournal(createFileJournalStorage(path));
	const first = generateBlobId('json');
	expectOk(
		await journal.record({
			kind: 'publication',
			id: first,
			reason: 'manual',
			metadata,
			bytes: new Uint8Array([1, 2, 3]),
		}),
	);
	const operation = crypto.randomUUID();
	expectOk(
		await journal.record({ kind: 'restore', operation, backupId: first }),
	);
	const held = expectOk(await journal.load());
	expect(held).toEqual({ kind: 'restore', operation, backupId: first });
});

test('a restore intent carries its unpublished safety capture and then stops carrying it', async () => {
	const path = await directory();
	const journal = createRecoveryJournal(createFileJournalStorage(path));
	const operation = crypto.randomUUID();
	const backupId = generateBlobId('json');
	const safety = {
		id: generateBlobId('json'),
		reason: 'before-restore' as const,
		metadata,
		bytes: new TextEncoder().encode('destination capture'),
	};
	expectOk(
		await journal.record({ kind: 'restore', operation, backupId, safety }),
	);
	expect(
		expectOk(
			await createRecoveryJournal(createFileJournalStorage(path)).load(),
		),
	).toEqual({ kind: 'restore', operation, backupId, safety });
	expectOk(await journal.record({ kind: 'restore', operation, backupId }));
	expect(
		expectOk(
			await createRecoveryJournal(createFileJournalStorage(path)).load(),
		),
	).toEqual({ kind: 'restore', operation, backupId });
});

test('a payload that does not match its header is cleared rather than published', async () => {
	for (const damage of ['truncate', 'replace', 'remove'] as const) {
		const path = await directory();
		const journal = createRecoveryJournal(createFileJournalStorage(path));
		expectOk(
			await journal.record({
				kind: 'publication',
				id: generateBlobId('json'),
				reason: 'imported',
				metadata,
				bytes: new TextEncoder().encode('the whole file'),
			}),
		);
		const payload = join(path, 'payload.bin');
		if (damage === 'truncate') await writeFile(payload, 'the whole');
		if (damage === 'replace') await writeFile(payload, 'the whole fila');
		if (damage === 'remove') await rm(payload);
		expect(
			expectOk(
				await createRecoveryJournal(createFileJournalStorage(path)).load(),
			),
		).toBeUndefined();
		// Cleared, so the next action starts from a fresh capture rather than
		// resuming bytes this record cannot vouch for.
		expect(expectOk(await journal.load())).toBeUndefined();
	}
});

test('the address separates every library that could hold an intent', () => {
	const base = {
		server: 'https://api.epicenter.so',
		account: 'alice',
		appId: 'so.epicenter.notes',
		dataId: 'so.epicenter.notes',
		library:
			'libraries/apps/so.epicenter.notes/personal/alice/data/so.epicenter.notes',
	};
	const addresses = new Set([
		recoveryJournalAddress(base),
		recoveryJournalAddress({ ...base, server: 'http://localhost:8787' }),
		recoveryJournalAddress({ ...base, account: 'bob' }),
		recoveryJournalAddress({ ...base, appId: 'so.epicenter.vocab' }),
		recoveryJournalAddress({ ...base, dataId: 'so.epicenter.other' }),
		recoveryJournalAddress({ ...base, library: `${base.library}/two` }),
	]);
	expect(addresses.size).toBe(6);
	expect(recoveryJournalAddress(base)).toBe(
		recoveryJournalAddress({ ...base }),
	);
	expect(() => recoveryJournalAddress({ ...base, account: '' })).toThrow(
		'complete identity',
	);
});

test('the browser journal survives the cache discard that a restore performs', async () => {
	const address = recoveryJournalAddress({
		server: 'https://api.epicenter.so',
		account: 'alice',
		appId: 'so.epicenter.notes',
		dataId: 'so.epicenter.notes',
		library:
			'libraries/apps/so.epicenter.notes/personal/alice/data/so.epicenter.notes',
	});
	const storage = await openIdbJournalStorage(address);
	const journal = createRecoveryJournal(storage);
	const intent: PublicationIntent = {
		kind: 'publication',
		id: generateBlobId('json'),
		reason: 'manual',
		metadata,
		bytes: new Uint8Array([7, 8, 9]),
	};
	expectOk(await journal.record(intent));
	const cache = expectOk(await openCurrentCache(`${address}/replica`));
	await cache.install({
		generation: 1,
		bytes: new Uint8Array([1, 2]),
		position: 1,
	});
	// Exactly the event the record has to outlive.
	await cache.discard();
	cache.close();
	storage.close();
	const reopened = await openIdbJournalStorage(address);
	try {
		expect(expectOk(await createRecoveryJournal(reopened).load())).toEqual(
			intent,
		);
	} finally {
		reopened.close();
	}
});
