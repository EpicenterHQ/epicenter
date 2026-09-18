/**
 * Complete runtime integration: production App lifetime over isolated storage,
 * physical SQL closure, synchronous admission, and failure-safe ownership.
 */
import { expect, spyOn, test } from 'bun:test';
import { secretLabel } from '@epicenter/device';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { defineApp, defineTable, field } from './index.js';
import { openApp } from './open.js';
import { createMemoryRuntime } from './testing.js';

const definition = defineApp({
	id: 'test.complete-runtime',
	kv: {},
	tables: { notes: defineTable({ title: field.string() }) },
});

test('one runtime reopens committed storage while another is isolated', async () => {
	const runtime = createMemoryRuntime();
	const separate = createMemoryRuntime();
	const first = openApp(definition, { runtime });
	await expect(runtime.dispose()).rejects.toThrow('open Apps');
	expectOk(await first.ready);
	first.device.tables.notes.create({ title: 'kept' });
	const blobId = expectOk(await first.blobs.local.add(new Blob(['audio'])));
	const secret = secretLabel('credential');
	expectOk(await first.device.secrets.put(secret, 'kept-secret'));
	const db = expectOk(await first.device.sqlite.open('search'));
	expectOk(await db.run('CREATE TABLE notes (title TEXT)'));
	expectOk(await db.run("INSERT INTO notes VALUES ('kept')"));
	expectOk(await db.run('CREATE TEMP TABLE temporary (value TEXT)'));
	expectOk(await db.run('BEGIN'));
	expectOk(await db.run("INSERT INTO notes VALUES ('uncommitted')"));
	await first.device.connections.custom!.add({
		baseUrl: 'https://inference.test/v1',
	});
	await first.close();
	expect(() => db.run("INSERT INTO notes VALUES ('late')")).toThrow();
	const reopened = openApp(definition, { runtime });
	const isolated = openApp(definition, { runtime: separate });
	expectOk(await reopened.ready);
	expectOk(await isolated.ready);
	expect(reopened.device.tables.notes.rows.map((row) => row.title)).toEqual([
		'kept',
	]);
	expect(isolated.device.tables.notes.rows).toEqual([]);
	expect(await expectOk(await reopened.blobs.local.get(blobId)).text()).toBe(
		'audio',
	);
	expectErr(await isolated.blobs.local.get(blobId));
	expect(expectOk(await reopened.device.secrets.get(secret))).toBe(
		'kept-secret',
	);
	expect(expectOk(await isolated.device.secrets.get(secret))).toBeNull();
	const sql = expectOk(await reopened.device.sqlite.open('search'));
	expect(expectOk(await sql.all('SELECT title FROM notes'))).toEqual([
		{ title: 'kept' },
	]);
	expect(
		expectOk(
			await sql.all(
				"SELECT name FROM sqlite_temp_master WHERE name='temporary'",
			),
		),
	).toEqual([]);
	expectErr(await sql.query('DELETE FROM notes', { tables: ['notes'] }));
	expectOk(await sql.run("INSERT INTO notes VALUES ('after query denial')"));
	const isolatedSql = expectOk(await isolated.device.sqlite.open('search'));
	expectErr(await isolatedSql.all('SELECT title FROM notes'));
	expect(reopened.device.connections.custom!.getAll()).toHaveLength(1);
	expect(isolated.device.connections.custom!.getAll()).toHaveLength(0);
	expect(expectErr(await reopened.device.recording.start({})).name).toBe(
		'NoInputDevice',
	);
	expect(reopened.device.connections.runtime).toBeNull();
	await reopened.close();
	await isolated.close();
	await runtime.dispose();
	await runtime.dispose();
	await separate.dispose();
	const retired = openApp(definition, { runtime });
	expect(expectErr(await retired.ready).name).toBe('ClaimFailed');
	await retired.close();
});

test('closing a refused duplicate cannot release the incumbent', async () => {
	const runtime = createMemoryRuntime();
	const first = openApp(definition, { runtime });
	const second = openApp(definition, { runtime });
	expectOk(await first.ready);
	expect(expectErr(await second.ready).name).toBe('AlreadyOpen');
	await second.close();
	await expect(runtime.dispose()).rejects.toThrow('open Apps');
	const third = openApp(definition, { runtime });
	expect(expectErr(await third.ready).name).toBe('AlreadyOpen');
	await third.close();
	await first.close();
	await runtime.dispose();
});

test.each([
	'close',
	'constructor failure',
] as const)('pending admission releases after %s', async (action) => {
	const runtime = createMemoryRuntime();
	const gate = Promise.withResolvers<void>();
	let released = false;
	const injected = {
		...runtime,
		async claim(...args: Parameters<typeof runtime.claim>) {
			const owned = expectOk(await runtime.claim(...args));
			await gate.promise;
			return Ok({
				release() {
					released = true;
					owned.release();
				},
			});
		},
		blobs:
			action === 'constructor failure'
				? () => {
						throw new Error('construction failed');
					}
				: runtime.blobs,
	};
	let closing: Promise<void> | undefined;
	if (action === 'constructor failure') {
		expect(() => openApp(definition, { runtime: injected })).toThrow(
			'construction failed',
		);
	} else {
		const app = openApp(definition, { runtime: injected });
		closing = app.close();
	}
	await expect(runtime.dispose()).rejects.toThrow('open Apps');
	expect(released).toBe(false);
	gate.resolve();
	if (closing) await closing;
	// A throwing constructor has no handle; its shared cleanup owns this release.
	for (let turn = 0; !released && turn < 100; turn++) await Bun.sleep(0);
	expect(released).toBe(true);
	await runtime.dispose();
});

test('failed document cleanup retains runtime admission and refuses disposal', async () => {
	const runtime = createMemoryRuntime();
	const app = openApp(definition, {
		runtime: {
			...runtime,
			async data(...args) {
				const backing = expectOk(await runtime.data(...args));
				return Ok({
					...backing,
					async dispose() {
						await backing.dispose?.();
						throw new Error('cleanup failed');
					},
				});
			},
		},
	});
	expectOk(await app.ready);
	await expect(app.close()).rejects.toThrow('cleanup failed');
	await expect(runtime.dispose()).rejects.toThrow('open Apps');
	const duplicate = openApp(definition, { runtime });
	expect(expectErr(await duplicate.ready).name).toBe('AlreadyOpen');
	await duplicate.close();
	expect(app.canRetryClose).toBe(false);
	await expect(app.close()).rejects.toThrow('cleanup failed');
	await expect(runtime.dispose()).rejects.toThrow('open Apps');
});

test('different Apps observe the shared memory AI catalog without a lock simulator', async () => {
	const runtime = createMemoryRuntime();
	const first = openApp(definition, { runtime });
	const other = openApp(
		defineApp({ ...definition, id: 'test.other-runtime-app' }),
		{ runtime },
	);
	expectOk(await first.ready);
	expectOk(await other.ready);
	const changes: number[] = [];
	const unsubscribe = other.device.connections.custom!.subscribe((rows) =>
		changes.push(rows.length),
	);
	await Promise.all(
		Array.from({ length: 20 }, (_, index) =>
			(index % 2 ? first : other).device.connections.custom!.add({
				baseUrl: `https://provider${index}.test/v1`,
			}),
		),
	);
	expect(first.device.connections.custom!.getAll()).toHaveLength(20);
	expect(other.device.connections.custom!.getAll()).toHaveLength(20);
	expect(changes.at(-1)).toBe(20);
	unsubscribe();
	await first.close();
	await other.close();
	await runtime.dispose();
});

test('an injected runtime never falls back to ambient inference fetch', async () => {
	const runtime = createMemoryRuntime();
	// The transport is intentionally unavailable; saved catalog entries still exist.
	const ai = runtime.ai;
	const app = openApp(definition, { runtime: { ...runtime, ai } });
	expectOk(await app.ready);
	const id = await app.device.connections.custom!.add({
		baseUrl: 'https://must-not-connect.invalid/v1',
	});
	const ambient = spyOn(globalThis, 'fetch').mockImplementation(
		Object.assign(
			async () => {
				throw new Error('Ambient inference transport was reached.');
			},
			{ preconnect: globalThis.fetch.preconnect },
		),
	);
	try {
		await expect(
			(async () =>
				await app.device.connections.custom!.get(id)!.client.models.list())(),
		).rejects.toThrow();
		expect(ambient).not.toHaveBeenCalled();
	} finally {
		ambient.mockRestore();
	}
	await app.close();
	await runtime.dispose();
});
