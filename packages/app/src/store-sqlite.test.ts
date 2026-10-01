/** Store-owned SQL isolates accounts and runtimes, fences retained connections,
 * drains admitted work, and retains exclusion when acquisition or cleanup is uncertain. */
import { expect, test } from 'bun:test';
import type { Account } from '@epicenter/auth';
import { createSqliteOwner } from '@epicenter/device/owner';
import { asPrincipalId } from '@epicenter/principal';
import { createCurrentDownloadResponse } from '@epicenter/sync/current-download';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { StoreError } from './data/store/store.js';
import { defineStore } from './index.js';
import { openLocal, openPersonal } from './open-store.js';
import { createMemoryStoreRuntime } from './testing.js';

const definition = defineStore({ id: 'test.store-sqlite', tables: {}, kv: {} });
function accountFor(principalId = 'alice', authorityId = 'test'): Account {
	return {
		authorityId,
		principalId: asPrincipalId(principalId),
		baseURL: 'https://stores.test',
		async fetch(_input, init) {
			return createCurrentDownloadResponse({
				generation: 1,
				head: 1,
				snapshot: {
					position: 1,
					bytes: new Uint8Array(await new Response(init?.body).arrayBuffer()),
				},
				tail: [],
			});
		},
		async openWebSocket() {
			return Object.assign(new EventTarget(), {
				readyState: 0,
				close() {},
				send() {},
			}) as unknown as WebSocket;
		},
		async getProfile() {
			throw new Error('Unused');
		},
	};
}

test('Local, captured accounts, authorities, and complete test runtimes retain separate SQL', async () => {
	const runtime = createMemoryStoreRuntime();
	const isolated = createMemoryStoreRuntime();
	const local = await openLocal(definition, { runtime });
	const old = expectOk(await local.sqlite.open('local'));
	expectOk(await old.run('CREATE TABLE pending (value TEXT)'));
	expectOk(await old.run("INSERT INTO pending VALUES ('unattributed work')"));
	for (const account of [
		accountFor(),
		accountFor('bob'),
		accountFor('alice', 'other'),
	]) {
		const personal = await openPersonal(definition, { account, runtime });
		expect(Object.keys(personal.sqlite)).toEqual(['open', 'delete']);
		expect('account' in personal).toBe(false);
		const db = expectOk(await personal.sqlite.open('local'));
		expectErr(await db.all('SELECT * FROM pending'));
		expectOk(await db.run('CREATE TABLE pending (value TEXT)'));
		expectOk(
			await db.run('INSERT INTO pending VALUES (?)', [
				account.principalId + account.authorityId,
			]),
		);
		await personal.close();
	}
	const account = accountFor();
	const gate = Promise.withResolvers<void>();
	const opening = openPersonal(definition, {
		account,
		runtime: {
			...runtime,
			async sqlite(id, identity) {
				expect(Object.keys(identity!)).toEqual(['authorityId', 'principalId']);
				expect(structuredClone(identity)).toEqual({
					authorityId: 'test',
					principalId: asPrincipalId('alice'),
				});
				return runtime.sqlite(id, identity);
			},
			async claim(address) {
				const result = await runtime.claim(address);
				await gate.promise;
				return result;
			},
		},
	});
	Object.assign(account, { principalId: asPrincipalId('bob') });
	gate.resolve();
	const captured = await opening;
	const db = expectOk(await captured.sqlite.open('local'));
	expect(expectOk(await db.all('SELECT * FROM pending'))).toEqual([
		{ value: 'alicetest' },
	]);
	const other = await openLocal(definition, { runtime: isolated });
	expectErr(
		await expectOk(await other.sqlite.open('local')).all(
			'SELECT * FROM pending',
		),
	);
	await Promise.all([captured.close(), local.close(), other.close()]);
	const reopened = await openLocal(definition, { runtime });
	expect(
		expectOk(
			await expectOk(await reopened.sqlite.open('local')).all(
				'SELECT * FROM pending',
			),
		),
	).toEqual([{ value: 'unattributed work' }]);
	await reopened.close();
	await Promise.all([runtime.dispose(), isolated.dispose()]);
});

test('close fences SQL before abort callbacks and preserves admitted operations', async () => {
	const runtime = createMemoryStoreRuntime();
	const store = await openLocal(definition, { runtime });
	const db = expectOk(await store.sqlite.open('notes'));
	expectOk(await db.run('CREATE TABLE notes (value TEXT)'));
	const admitted = db.run("INSERT INTO notes VALUES ('kept')");
	let late: ReturnType<typeof db.run> | undefined;
	store.signal.addEventListener('abort', () => {
		late = db.run("INSERT INTO notes VALUES ('late')");
	});
	const closing = store.close();
	expect(store.close()).toBe(closing);
	await expect(store.sqlite.open('notes')).rejects.toThrow();
	await expect(store.sqlite.delete('notes')).rejects.toThrow();
	expectOk(await admitted);
	expectErr(await late!);
	await closing;
	const next = await openLocal(definition, { runtime });
	const kept = expectOk(await next.sqlite.open('notes'));
	expect(expectOk(await kept.all('SELECT * FROM notes'))).toEqual([
		{ value: 'kept' },
	]);
	expectOk(await next.sqlite.delete('notes'));
	expectErr(await kept.all('SELECT 1'));
	expectErr(
		await expectOk(await next.sqlite.open('notes')).all('SELECT * FROM notes'),
	);
	for (const name of ['', '../escape', 'file.sqlite']) {
		expect(expectErr(await next.sqlite.open(name)).name).toBe(
			'InvalidDatabaseName',
		);
		expect(expectErr(await next.sqlite.delete(name)).name).toBe(
			'InvalidDatabaseName',
		);
	}
	await next.close();
	await runtime.dispose();
});

test('document failure waits for late SQL acquisition and closes it before releasing admission', async () => {
	const runtime = createMemoryStoreRuntime();
	const entered = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	let closed = false;
	const opening = openLocal(definition, {
		runtime: {
			...runtime,
			async data() {
				return StoreError.StorageFailed({
					cause: new Error('document refused'),
				});
			},
			async sqlite(...args) {
				entered.resolve();
				await gate.promise;
				const namespace = await runtime.sqlite(...args);
				return {
					...namespace,
					async close() {
						await namespace.close();
						closed = true;
					},
				};
			},
		},
	});
	void opening.catch(() => {});
	await entered.promise;
	await expect(openLocal(definition, { runtime })).rejects.toMatchObject({
		name: 'AlreadyOpen',
	});
	gate.resolve();
	await expect(opening).rejects.toBeDefined();
	expect(closed).toBe(true);
	await (await openLocal(definition, { runtime })).close();
	await runtime.dispose();
});

test('SQL acquisition failure drains late document and blob success and retains uncertain exclusion', async () => {
	const runtime = createMemoryStoreRuntime();
	const gate = Promise.withResolvers<void>();
	let documentClosed = false;
	let blobsClosed = false;
	const opening = openLocal(definition, {
		runtime: {
			...runtime,
			async sqlite() {
				throw new Error('SQL ownership uncertain');
			},
			async data(...args) {
				await gate.promise;
				const backing = expectOk(await runtime.data(...args));
				return Ok({
					...backing,
					async dispose() {
						await backing.dispose?.();
						documentClosed = true;
					},
				});
			},
			async localBlobs(...args) {
				await gate.promise;
				const blobs = expectOk(await runtime.localBlobs(...args));
				return Ok({
					...blobs,
					async close() {
						await blobs.close();
						blobsClosed = true;
					},
				});
			},
		},
	});
	void opening.catch(() => {});
	gate.resolve();
	await expect(opening).rejects.toThrow();
	expect(documentClosed).toBe(true);
	expect(blobsClosed).toBe(true);
	await expect(openLocal(definition, { runtime })).rejects.toMatchObject({
		name: 'AlreadyOpen',
	});
});

test('failed physical SQL cleanup keeps both store and physical exclusion', async () => {
	const runtime = createMemoryStoreRuntime();
	const owner = createSqliteOwner({
		async open() {
			throw new Error('Unused');
		},
		async delete() {},
		async release() {
			throw new Error('uncertain physical release');
		},
	});
	const store = await openLocal(definition, {
		runtime: { ...runtime, sqlite: owner.acquire },
	});
	const closing = store.close();
	await expect(closing).rejects.toThrow('uncertain physical release');
	expect(store.close()).toBe(closing);
	await expect(openLocal(definition, { runtime })).rejects.toMatchObject({
		name: 'AlreadyOpen',
	});
	await expect(owner.acquire(definition.id)).rejects.toThrow(
		'already acquired',
	);
	await expect(runtime.dispose()).rejects.toThrow('open stores');
});
