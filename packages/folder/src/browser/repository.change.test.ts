/**
 * Change notification and failed publication in the local engine.
 * A notification follows a committed save, reaches every handle of the same
 * database in this page or another tab, and ends when its handle closes. A
 * save that cannot commit returns the browser's reason and changes nothing.
 */
import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { type LocalRepository, openRepository } from './repository.js';
import type { StorageChange } from './storage.js';

/** Resolves with the next change this handle hears. */
function nextChange(repository: LocalRepository) {
	return new Promise<StorageChange>((resolve, reject) => {
		const timer = setTimeout(() => {
			stop();
			reject(new Error('No change was heard'));
		}, 2000);
		const stop = repository.onChange((change) => {
			clearTimeout(timer);
			stop();
			resolve(change);
		});
	});
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('a committed save notifies its own handle and every other handle of the database', async () => {
	const id = crypto.randomUUID();
	const a = await openRepository(id);
	const b = await openRepository(id);
	try {
		const heardByA = nextChange(a);
		const heardByB = nextChange(b);
		expectOk(await a.files.write('notes/one.md', null, 'first'));
		expect(await heardByA).toEqual({
			origin: 'this-handle',
			paths: ['notes/one.md'],
		});
		expect(await heardByB).toEqual({
			origin: 'other-handle',
			paths: ['notes/one.md'],
		});
		const heardDelete = nextChange(b);
		expectOk(await a.files.delete('notes/one.md', 'first'));
		expect(await heardDelete).toEqual({
			origin: 'other-handle',
			paths: ['notes/one.md'],
		});
	} finally {
		a.close();
		b.close();
	}
});

test('a save that changes nothing or is refused notifies nobody', async () => {
	const a = await openRepository(crypto.randomUUID());
	try {
		expectOk(await a.files.write('notes/one.md', null, 'first'));
		const heard: StorageChange[] = [];
		a.onChange((change) => heard.push(change));
		// The same content is no change; a file cannot replace a folder.
		expectOk(await a.files.write('notes/one.md', 'first', 'first'));
		expect(expectErr(await a.files.write('notes', null, 'x')).name).toBe(
			'Occupied',
		);
		await settle();
		expect(heard).toEqual([]);
	} finally {
		a.close();
	}
});

test('closing a handle releases its listeners and its channel', async () => {
	const id = crypto.randomUUID();
	const a = await openRepository(id);
	const b = await openRepository(id);
	let heard = 0;
	b.onChange(() => heard++);
	b.close();
	expect(() => b.onChange(() => {})).toThrow('closed');
	try {
		expectOk(await a.files.write('notes/one.md', null, 'first'));
		await settle();
		expect(heard).toBe(0);
	} finally {
		a.close();
	}
});

test('a listener that throws neither fails the save nor silences later listeners', async () => {
	const a = await openRepository(crypto.randomUUID());
	try {
		let heard = 0;
		a.onChange(() => {
			throw new Error('listener failure');
		});
		a.onChange(() => heard++);
		expectOk(await a.files.write('notes/one.md', null, 'first'));
		expect(heard).toBe(1);
	} finally {
		a.close();
	}
});

test('a failed publication returns the browser reason and leaves earlier saves intact', async () => {
	const id = crypto.randomUUID();
	const a = await openRepository(id);
	try {
		expectOk(await a.files.write('notes/one.md', null, 'first'));
		const heard: StorageChange[] = [];
		a.onChange((change) => heard.push(change));
		const put = IDBObjectStore.prototype.put;
		IDBObjectStore.prototype.put = () => {
			throw new DOMException('Disk is full', 'QuotaExceededError');
		};
		try {
			const failure = expectErr(
				await a.files.write('notes/one.md', 'first', 'second'),
			);
			expect(failure.name).toBe('StorageFailed');
			expect(failure.message).toContain('QuotaExceededError');
			expectErr(await a.files.write('notes/two.md', null, 'other'));
		} finally {
			IDBObjectStore.prototype.put = put;
		}
		await settle();
		expect(heard).toEqual([]);
		expect(await a.files.list().then(expectOk)).toEqual(['notes/one.md']);
		const read = expectOk(await a.files.read('notes/one.md'));
		expect(await read?.content.text()).toBe('first');
		// The handle still works, and the earlier save survives a reopen.
		expectOk(await a.files.write('notes/one.md', 'first', 'third'));
		a.close();
		const reopened = await openRepository(id);
		try {
			const again = expectOk(await reopened.files.read('notes/one.md'));
			expect(await again?.content.text()).toBe('third');
		} finally {
			reopened.close();
		}
	} finally {
		a.close();
	}
});
