/**
 * Shared library exclusion tests.
 * SQLite lifetimes exclude other SQLite lifetimes for the same app.
 * Data library claims occupy a separate namespace. Acquisition failures release ownership; failed physical closes retain it.
 */
import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { claimLibrary, claimSqlite } from './library-claim.js';
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

test('a raw SQLite claim refuses standalone SQL before backend acquisition', async () => {
	const appId = 'so.epicenter.raw-claim';
	const claim = expectOk(await claimSqlite(appId));
	let acquisitions = 0;
	const storage = createAppSqlite(
		{
			async acquire() {
				acquisitions++;
				throw new Error('must not acquire');
			},
		},
		appId,
	);
	expect(expectErr(await storage.acquire()).name).toBe('AlreadyOpen');
	expect(expectErr(await storage.value.open('search')).name).toBe(
		'AlreadyOpen',
	);
	expect(expectErr(await storage.value.delete('search')).name).toBe(
		'AlreadyOpen',
	);
	expect(acquisitions).toBe(0);
	await storage.close();
	expect(expectErr(await claimSqlite(appId)).name).toBe('AlreadyOpen');
	claim.release();
});

test('a SQL lifetime excludes raw SQLite claims until its close completes', async () => {
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
	);
	expectOk(await storage.acquire());
	expect(expectErr(await claimSqlite(appId)).name).toBe('AlreadyOpen');
	const closing = storage.close();
	expect(expectErr(await claimSqlite(appId)).name).toBe('AlreadyOpen');
	gate.resolve();
	await closing;
	expectOk(await claimSqlite(appId)).release();
});

test('library claims remain independent of device SQLite and each other', async () => {
	const appId = 'so.epicenter.claim-identities';
	const storage = createAppSqlite(unopenedOwner(), appId);
	expectOk(await storage.acquire());
	const claims = [];
	for (const replica of [
		{ library: 'local' as const },
		{
			library: 'personal' as const,
			account: { authorityId: 'cloud', principalId: asPrincipalId('alice') },
		},
		{
			library: 'personal' as const,
			account: { authorityId: 'cloud', principalId: asPrincipalId('bob') },
		},
	])
		claims.push(expectOk(await claimLibrary(appId, replica)));
	for (const claim of claims) claim.release();
	await storage.close();
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
	);
	expect(expectErr(await storage.acquire())).toMatchObject({
		name: 'StorageFailed',
		cause,
	});
	await storage.close();
	expectOk(await claimSqlite(appId)).release();
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
	);
	const acquiring = storage.acquire();
	await started.promise;
	const closing = storage.close();
	expect(expectErr(await claimSqlite(appId)).name).toBe('AlreadyOpen');
	gate.resolve();
	expectOk(await acquiring);
	await closing;
	expect(closed).toBe(true);
	expectOk(await claimSqlite(appId)).release();
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
	);
	expectOk(await storage.acquire());
	await expect(storage.close()).rejects.toThrow('physical close failed');
	expect(expectErr(await claimSqlite(appId)).name).toBe('AlreadyOpen');
});

test('missing locks, thrown requests and rejected requests preserve distinct claim failures', async () => {
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			'--eval',
			`
   const { claimLibrary } = await import(${JSON.stringify(new URL('./library-claim.ts', import.meta.url).href)});
   Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
   const results = [await claimLibrary('so.epicenter.claim-errors', { library: 'local' })];
   navigator.locks = { request() { throw new Error('request threw'); } };
   results.push(await claimLibrary('so.epicenter.claim-errors', { library: 'local' }));
   navigator.locks = { request() { return Promise.reject(new Error('request rejected')); } };
   results.push(await claimLibrary('so.epicenter.claim-errors', { library: 'local' }));
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
	const address = 'library:["so.epicenter.claim-errors","device","no-account"]';
	expect(JSON.parse(stdout)).toEqual([
		{ name: 'LocksUnsupported', address },
		{ name: 'ClaimFailed', address, cause: 'request threw' },
		{ name: 'ClaimFailed', address, cause: 'request rejected' },
	]);
});

test('personal and shared lifetimes are distinct while duplicate shared ownership is refused', async () => {
	const appId = 'so.epicenter.library-kind-claim';
	const alice = { authorityId: 'server', principalId: asPrincipalId('alice') };
	const shared = { library: 'shared' as const, account: alice };
	const claims = [
		expectOk(
			await claimLibrary(appId, { library: 'personal', account: alice }),
		),
		expectOk(await claimLibrary(appId, shared)),
		expectOk(
			await claimLibrary(appId, {
				...shared,
				account: { ...alice, principalId: asPrincipalId('bob') },
			}),
		),
	];
	expect(expectErr(await claimLibrary(appId, shared)).name).toBe('AlreadyOpen');
	for (const claim of claims) claim.release();
});

test('library claim keys project identity in stable order and omit account capabilities', async () => {
	const appId = 'so.epicenter.claim-bytes';
	const account = {
		principalId: asPrincipalId('alice'),
		authorityId: 'cloud',
		baseURL: 'https://cloud.test',
		token: 'never-in-lock-key',
	};
	const scope = { account, library: 'personal' as const };
	const held = expectOk(await claimLibrary(appId, scope));
	try {
		const error = expectErr(await claimLibrary(appId, scope));
		expect(error.address).toBe(
			'library:["so.epicenter.claim-bytes",{"library":"personal","account":{"authorityId":"cloud","principalId":"alice"}}]',
		);
	} finally {
		held.release();
	}
});

test('library claims reject unsafe account address segments', async () => {
	for (const invalid of ['', '.', '..', 'a/b', 'a\\b', 'a\n']) {
		for (const field of ['authorityId', 'principalId']) {
			const account = {
				authorityId: 'cloud',
				principalId: asPrincipalId('alice'),
				[field]: invalid,
			};
			await expect(
				claimLibrary('so.epicenter.invalid-claim', {
					library: 'personal',
					account,
				}),
			).rejects.toThrow('Invalid library account address');
		}
	}
});
