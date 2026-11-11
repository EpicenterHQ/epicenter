/**
 * Mail actions project pending intent immediately and retain it across failures.
 * Delivery retires only carried sequences; rebuilding the cache preserves intent.
 */

import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryContext, inRun } from '@epicenter/app';
import app from './epicenter.js';
import { messages } from './lib/fixture.js';
import { openFixtureGmail } from './lib/gmail.js';
import { pull, reconcilePass } from './lib/reconcile.js';
import { openStore } from './lib/store.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function setup() {
	const dir = mkdtempSync(join(tmpdir(), 'mail-test-'));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const context = { folder: { ...createMemoryContext({}).folder, path: dir } };
	const run = <T>(call: () => T) => inRun(context, call);
	return { dir, run };
}
async function mirrored() {
	const f = setup();
	const store = openStore(f.dir);
	const gmail = openFixtureGmail(f.dir);
	cleanups.push(() => {
		store.close();
		gmail.close();
	});
	await pull(store, gmail);
	return { ...f, store, gmail };
}
const id = messages[0]!.id;

test('an unrefreshed mirror returns an empty search', async () => {
	const f = setup();
	expect(await f.run(() => app.actions.search({}))).toMatchObject({
		messages: [],
		refreshedAt: null,
	});
});

test('search applies operators, phrases, negation, dates and hidden-label defaults', async () => {
	const f = setup();
	await f.run(() => app.actions.refresh({}));
	const search = (query: string) => f.run(() => app.actions.search({ query }));
	expect(
		(await search('from:orders@example.com')).messages.map((m) => m.id),
	).toEqual(
		messages
			.slice(0, 4)
			.reverse()
			.map((m) => m.id),
	);
	expect(
		(await search('label:receipts is:unread')).messages.map((m) => m.id),
	).toEqual([6, 4, 2, 0].map((i) => messages[i]!.id));
	expect((await search('label:Label_1')).total).toBe(8);
	expect((await search('subject:"Sunday lunch" -tart')).total).toBe(3);
	expect((await search('to:mira after:2026/11/01')).total).toBe(2);
	expect((await search('before:2026-09-02')).messages.map((m) => m.id)).toEqual(
		[id],
	);
	expect((await search('')).total).toBe(22);
	expect((await search('in:trash')).messages.map((m) => m.id)).toEqual([
		messages[22]!.id,
	]);
	expect((await search('label:spam')).total).toBe(1);
	expect((await search('in:anywhere')).total).toBe(24);
	expect((await search('%')).total).toBe(0);
	expect((await search('_')).total).toBe(0);
	expect((await search('unknown:value')).total).toBe(0);
});

test('intent changes search and counts immediately; reassertion overwrites with a higher sequence', async () => {
	const f = setup();
	await f.run(() => app.actions.refresh({}));
	const before = await f.run(() => app.actions.labels({}));
	const first = await f.run(() =>
		app.actions.label({ ids: [id], add: ['starred'], remove: [] }),
	);
	expect(first.pending).toBe(1);
	const result = await f.run(() =>
		app.actions.search({ query: 'is:starred is:pending' }),
	);
	expect(result.messages.map((m) => m.id)).toEqual([id]);
	expect(result.messages[0]!.pending).toMatchObject([
		{ id: 'STARRED', want: true },
	]);
	const after = await f.run(() => app.actions.labels({}));
	expect(after.find((l) => l.id === 'STARRED')!.total).toBe(
		before.find((l) => l.id === 'STARRED')!.total + 1,
	);
	const second = await f.run(() =>
		app.actions.label({ ids: [id], add: [], remove: ['STARRED'] }),
	);
	expect(second.asserted[0]!.seq).toBeGreaterThan(first.asserted[0]!.seq);
	expect(second.pending).toBe(1);
	expect((await f.run(() => app.actions.show({ id }))).starred).toBe(false);
});

test('unknown labels and overlapping add/remove refuse the entire assertion', async () => {
	const f = setup();
	await f.run(() => app.actions.refresh({}));
	await expect(
		f.run(() =>
			app.actions.label({ ids: [id], add: ['UNREAD', 'unknown'], remove: [] }),
		),
	).rejects.toThrow('No label named "unknown"');
	await expect(
		f.run(() =>
			app.actions.label({ ids: [id], add: ['starred'], remove: ['STARRED'] }),
		),
	).rejects.toThrow('both');
	expect((await f.run(() => app.actions.status({}))).pending).toBe(0);
});

// Delivery and sequence ownership.
test('a systemic failure retains all rows and still pulls; a later pass delivers', async () => {
	const { store, gmail } = await mirrored();
	const remoteId = messages[2]!.id;
	gmail.modifyMessage(remoteId, { addLabelIds: ['STARRED'] });
	expect(store.show(remoteId).starred).toBe(false);
	store.assert([
		{ id, label: 'STARRED', want: true },
		{ id: messages[1]!.id, label: 'UNREAD', want: true },
	]);
	const rows = store.pendingRows();
	const result = await reconcilePass(store, {
		...gmail,
		modifyMessage() {
			throw new Error('offline');
		},
	});
	expect(result.failure).toBe('offline');
	expect(store.show(remoteId).starred).toBe(true);
	expect(store.pendingRows()).toEqual(rows);
	const retried = await reconcilePass(store, gmail);
	expect(retried.delivered).toHaveLength(2);
	expect(retried.pending).toBe(0);
	expect(store.show(id).starred).toBe(true);
});

test('404 and 400 discard carried assertions and report the reason', async () => {
	const { store, gmail } = await mirrored();
	store.assert([{ id: 'ffffffffffffffff', label: 'STARRED', want: true }]);
	const result = await reconcilePass(store, gmail);
	expect(result.discarded).toEqual([
		{
			id: 'ffffffffffffffff',
			labels: ['STARRED'],
			reason: 'No message ffffffffffffffff',
		},
	]);
	expect(result.pending).toBe(0);
	store.assert([{ id, label: 'bad', want: true }]);
	expect((await reconcilePass(store, gmail)).discarded[0]!.reason).toBe(
		'No label bad',
	);
});

test('an opposite assertion during modify survives retirement of the carried sequence', async () => {
	const { store, gmail } = await mirrored();
	const [first] = store.assert([{ id, label: 'STARRED', want: true }]);
	const result = await reconcilePass(store, {
		...gmail,
		modifyMessage(messageId, change) {
			const response = gmail.modifyMessage(messageId, change);
			store.assert([{ id, label: 'STARRED', want: false }]);
			return response;
		},
	});
	expect(result.delivered).toHaveLength(1);
	expect(result.pending).toBe(1);
	expect(store.pendingRows()[0]!.seq).toBeGreaterThan(first!.seq);
	expect(store.show(id).starred).toBe(false);
});

test('an absent labelIds response folds as empty and a pull failure is reported', async () => {
	const { store, gmail } = await mirrored();
	store.assert([{ id, label: 'UNREAD', want: false }]);
	const result = await reconcilePass(store, {
		...gmail,
		modifyMessage() {
			const { labelIds: _, ...message } = messages[0]!;
			return message;
		},
		listMessages() {
			throw new Error('pull stopped');
		},
	});
	expect(result.failure).toBe('pull stopped');
	expect(store.show(id).labels).toEqual([]);
	expect(result.pending).toBe(0);
});

test('a mirror version mismatch rebuilds the cache and preserves the intent file', async () => {
	const f = setup();
	let store = openStore(f.dir);
	const gmail = openFixtureGmail(f.dir);
	await pull(store, gmail);
	const rows = store.assert([{ id, label: 'STARRED', want: true }]);
	store.close();
	gmail.close();
	const intentPath = join(f.dir, 'intent.local.sqlite');
	const intentBytes = await Bun.file(intentPath).bytes();
	const old = new Database(join(f.dir, '.cache/mirror.sqlite'));
	old.exec('PRAGMA user_version=42');
	old.close();
	store = openStore(f.dir);
	try {
		expect(store.status()).toMatchObject({
			refreshedAt: null,
			messages: 0,
			pending: 1,
		});
		expect(store.pendingRows()).toEqual(rows);
		expect(await Bun.file(intentPath).bytes()).toEqual(intentBytes);
		expect(
			store.assert([{ id, label: 'STARRED', want: false }])[0]!.seq,
		).toBeGreaterThan(rows[0]!.seq);
	} finally {
		store.close();
	}
});
