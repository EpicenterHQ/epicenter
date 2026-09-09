/**
 * Shared library exclusion tests.
 * Raw generation claims and SQL-backed lifetimes contend for one app/account
 * key. Acquisition failures release ownership; failed physical closes retain it.
 */
import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { claimLibrary } from './library-claim.js';
import { createAppSqlite, createSqliteOwner } from './owner.js';
import { installTestLocks } from './test-locks.js';

installTestLocks();

function unopenedOwner() {
	return createSqliteOwner({
		async open() {
			throw new Error('No physical database requested.');
		},
		async delete() {
			throw new Error('No physical database requested.');
		},
	});
}

test('a raw library claim refuses standalone SQL before backend acquisition', async () => {
	const appId = 'so.epicenter.raw-claim';
	const claim = expectOk(await claimLibrary(appId, null));
	let acquisitions = 0;
	const storage = createAppSqlite(
		{
			async acquire() {
				acquisitions++;
				throw new Error('must not acquire');
			},
		},
		appId,
		null,
	);
	expect(expectErr(await storage.acquire()).name).toBe('AlreadyOpen');
	expect(expectErr(await storage.open('search')).name).toBe('AlreadyOpen');
	expect(expectErr(await storage.delete('search')).name).toBe('AlreadyOpen');
	expect(acquisitions).toBe(0);
	await storage.close();
	expect(expectErr(await claimLibrary(appId, null)).name).toBe('AlreadyOpen');
	claim.release();
});

test('a SQL-only lifetime excludes raw claims until its close completes', async () => {
	const appId = 'so.epicenter.sql-claim';
	const gate = Promise.withResolvers<void>();
	const storage = createAppSqlite(
		{
			async acquire() {
				return {
					async open() {
						throw new Error('unused');
					},
					async delete() {},
					async close() {
						await gate.promise;
					},
				};
			},
		},
		appId,
		null,
	);
	expectOk(await storage.acquire());
	expect(expectErr(await claimLibrary(appId, null)).name).toBe('AlreadyOpen');
	const closing = storage.close();
	expect(expectErr(await claimLibrary(appId, null)).name).toBe('AlreadyOpen');
	gate.resolve();
	await closing;
	expectOk(await claimLibrary(appId, null)).release();
});

test('application, authority, principal and local identity select independent claims', async () => {
	const appId = 'so.epicenter.claim-identities';
	const owner = unopenedOwner();
	const accounts = [
		null,
		{ authorityId: 'one:two', principalId: asPrincipalId('three') },
		{ authorityId: 'one', principalId: asPrincipalId('two:three') },
		{ authorityId: 'other', principalId: asPrincipalId('three') },
	];
	const storage = accounts.map((account) =>
		createAppSqlite(owner, appId, account),
	);
	for (const lifetime of storage) expectOk(await lifetime.acquire());
	const otherApp = expectOk(
		await claimLibrary('so.epicenter.another-claim', null),
	);
	expect(expectErr(await claimLibrary(appId, accounts[1]!)).name).toBe(
		'AlreadyOpen',
	);
	await Promise.all(storage.map((lifetime) => lifetime.close()));
	otherApp.release();
});

test('backend acquisition failure releases the claim and close finishes', async () => {
	const appId = 'so.epicenter.claim-acquire-failure';
	const cause = new Error('backend unavailable');
	const storage = createAppSqlite(
		{
			async acquire() {
				throw cause;
			},
		},
		appId,
		null,
	);
	expect(expectErr(await storage.acquire())).toMatchObject({
		name: 'StorageFailed',
		cause,
	});
	await storage.close();
	expectOk(await claimLibrary(appId, null)).release();
});

test('close during acquisition waits for backend release before releasing the library', async () => {
	const appId = 'so.epicenter.claim-pending';
	const gate = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	let closed = false;
	const storage = createAppSqlite(
		{
			async acquire() {
				started.resolve();
				await gate.promise;
				return {
					async open() {
						throw new Error('unused');
					},
					async delete() {},
					async close() {
						closed = true;
					},
				};
			},
		},
		appId,
		null,
	);
	const acquiring = storage.acquire();
	await started.promise;
	const closing = storage.close();
	expect(expectErr(await claimLibrary(appId, null)).name).toBe('AlreadyOpen');
	gate.resolve();
	expectOk(await acquiring);
	await closing;
	expect(closed).toBe(true);
	expectOk(await claimLibrary(appId, null)).release();
});

test('failed physical close permanently retains the library claim', async () => {
	const appId = 'so.epicenter.claim-close-failure';
	const storage = createAppSqlite(
		{
			async acquire() {
				return {
					async open() {
						throw new Error('unused');
					},
					async delete() {},
					async close() {
						throw new Error('physical close failed');
					},
				};
			},
		},
		appId,
		null,
	);
	expectOk(await storage.acquire());
	await expect(storage.close()).rejects.toThrow('physical close failed');
	expect(expectErr(await claimLibrary(appId, null)).name).toBe('AlreadyOpen');
});

test('missing locks, thrown requests and rejected requests preserve distinct claim failures', async () => {
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			'--eval',
			`
   const { claimLibrary } = await import(${JSON.stringify(new URL('./library-claim.ts', import.meta.url).href)});
   Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
   const results = [await claimLibrary('so.epicenter.claim-errors', null)];
   navigator.locks = { request() { throw new Error('request threw'); } };
   results.push(await claimLibrary('so.epicenter.claim-errors', null));
   navigator.locks = { request() { return Promise.reject(new Error('request rejected')); } };
   results.push(await claimLibrary('so.epicenter.claim-errors', null));
   console.log(JSON.stringify(results.map(({ error }) => ({ name: error.name, address: error.address, cause: error.cause?.message }))));
  `,
		],
		cwd: import.meta.dir,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect({ stderr, exitCode }).toEqual({ stderr: '', exitCode: 0 });
	const address = 'library:["so.epicenter.claim-errors",null,null]';
	expect(JSON.parse(stdout)).toEqual([
		{ name: 'LocksUnsupported', address },
		{ name: 'ClaimFailed', address, cause: 'request threw' },
		{ name: 'ClaimFailed', address, cause: 'request rejected' },
	]);
});
