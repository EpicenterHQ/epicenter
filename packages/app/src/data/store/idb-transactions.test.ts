/**
 * Native IndexedDB settlement and rollback protect admission and retry.
 * Request failures settle only after abort; failed folding, cache installation,
 * and retirement never publish partial durable records or advance live state.
 */
import { expect, test } from 'bun:test';
import * as Y from '@y/y';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { expectOk } from 'wellcrafted/testing';
import { openIdbBacking } from './browser.js';
import { openCurrentCache } from './current-cache.js';
import {
	type IdbRealm,
	idbRequest,
	idbTransactionDone,
	openIdbDatabase,
} from './idb-updates.js';
import { SNAPSHOT_FOLD_THRESHOLD } from './log.js';

const realm = (): IdbRealm => ({
	factory: new IDBFactory(),
	keyRange: IDBKeyRange,
});
const baseline = () => {
	const document = new Y.Doc();
	const bytes = Y.encodeStateAsUpdateV2(document);
	document.destroy();
	return bytes;
};

test('transaction failure reports the first request error only after rollback abort', async () => {
	const idb = realm();
	const database = await openIdbDatabase('settlement', ['updates'], idb);
	try {
		const transaction = database.transaction('updates', 'readwrite');
		const done = idbTransactionDone(transaction);
		const events: string[] = [];
		transaction.addEventListener('error', () => events.push('error'));
		transaction.addEventListener('abort', () => events.push('abort'));
		transaction.objectStore('updates').add('first', 1);
		transaction.objectStore('updates').add('duplicate', 1);
		await expect(
			done.catch((error) => {
				events.push('settled');
				throw error;
			}),
		).rejects.toMatchObject({ name: 'ConstraintError' });
		expect(events).toEqual(['error', 'abort', 'settled']);
		expect(
			await idbRequest(
				database.transaction('updates').objectStore('updates').count(),
			),
		).toBe(0);
	} finally {
		database.close();
	}
});

test('a failed fold leaves its chain intact and the same backing folds on retry', async () => {
	const idb = realm();
	const backing = expectOk(await openIdbBacking('fold-retry', idb));
	const bytes = baseline();
	try {
		for (let id = 1; id < SNAPSHOT_FOLD_THRESHOLD; id++)
			await backing.port.commit([
				{ kind: 'append', id, bytes, authoritySeq: 0 },
			]);
		const put = IDBObjectStore.prototype.put;
		let calls = 0;
		IDBObjectStore.prototype.put = function (
			...args: Parameters<IDBObjectStore['put']>
		) {
			if (++calls === 2) throw new Error('Fold baseline failed after deletes');
			return put.apply(this, args);
		};
		try {
			await expect(
				backing.port.commit([
					{
						kind: 'append',
						id: SNAPSHOT_FOLD_THRESHOLD,
						bytes,
						authoritySeq: 0,
					},
				]),
			).rejects.toThrow('Fold baseline failed after deletes');
		} finally {
			IDBObjectStore.prototype.put = put;
		}
		const aborted = expectOk(await openIdbBacking('fold-retry', idb));
		expect(aborted.loaded.updates).toHaveLength(SNAPSHOT_FOLD_THRESHOLD - 1);
		aborted.close();
		await backing.port.commit([
			{ kind: 'append', id: SNAPSHOT_FOLD_THRESHOLD, bytes, authoritySeq: 0 },
		]);
		const retried = expectOk(await openIdbBacking('fold-retry', idb));
		expect(retried.loaded.updates).toHaveLength(1);
		expect(retried.loaded.lastId).toBe(SNAPSHOT_FOLD_THRESHOLD);
		retried.close();
	} finally {
		backing.close();
	}
});

test('failed installation rolls back updates and permits installation on the same cache', async () => {
	const idb = realm();
	const cache = expectOk(await openCurrentCache('install-retry', idb));
	const bytes = baseline();
	const put = IDBObjectStore.prototype.put;
	IDBObjectStore.prototype.put = function (
		...args: Parameters<IDBObjectStore['put']>
	) {
		if (this.name === 'header') throw new Error('Header failed');
		return put.apply(this, args);
	};
	try {
		await expect(
			cache.install({ generation: 1, bytes, position: 1 }),
		).rejects.toThrow('Header failed');
	} finally {
		IDBObjectStore.prototype.put = put;
	}
	try {
		const db = await idbRequest(idb.factory.open('install-retry', 1));
		expect(
			await idbRequest(
				db.transaction('updates').objectStore('updates').count(),
			),
		).toBe(0);
		db.close();
		await cache.install({ generation: 2, bytes, position: 3 });
		cache.close();
		const reopened = expectOk(await openCurrentCache('install-retry', idb));
		expect(reopened.loaded?.generation).toBe(2);
		expect(reopened.loaded?.snapshot.cursor).toBe(3);
		reopened.close();
	} finally {
		cache.close();
	}
});

test('failed retirement preserves header and rows, fences writes, and can retry', async () => {
	const idb = realm();
	const cache = expectOk(await openCurrentCache('discard-retry', idb));
	await cache.install({ generation: 1, bytes: baseline(), position: 1 });
	const clear = IDBObjectStore.prototype.clear;
	IDBObjectStore.prototype.clear = function () {
		if (this.name === 'updates') throw new Error('Clear failed');
		return clear.call(this);
	};
	try {
		await expect(cache.discard()).rejects.toThrow('Clear failed');
	} finally {
		IDBObjectStore.prototype.clear = clear;
	}
	try {
		const intact = expectOk(await openCurrentCache('discard-retry', idb));
		expect(intact.loaded?.generation).toBe(1);
		expect(intact.loaded?.snapshot.updates).toHaveLength(1);
		intact.close();
		await expect(cache.port.commit([])).rejects.toThrow('retired or closed');
		await cache.discard();
		cache.close();
		const reopened = expectOk(await openCurrentCache('discard-retry', idb));
		expect(reopened.loaded).toBeUndefined();
		reopened.close();
	} finally {
		cache.close();
	}
});
