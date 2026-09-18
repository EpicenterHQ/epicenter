/**
 * Complete runtime integration: production App lifetime over isolated storage,
 * physical SQL closure, pending admission, and failure-safe ownership.
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
	const first = await openApp(definition, { runtime });
	await expect(runtime.dispose()).rejects.toThrow('open Apps');

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
	const reopened = await openApp(definition, { runtime });
	const isolated = await openApp(definition, { runtime: separate });

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
	await expect(retired).rejects.toMatchObject({ name: 'ClaimFailed' });
});

test('a rejected duplicate cannot release the incumbent', async () => {
	const runtime = createMemoryRuntime();
	const first = await openApp(definition, { runtime });
	const second = openApp(definition, { runtime });

	await expect(second).rejects.toMatchObject({ name: 'AlreadyOpen' });

	await expect(runtime.dispose()).rejects.toThrow('open Apps');
	const third = openApp(definition, { runtime });
	await expect(third).rejects.toMatchObject({ name: 'AlreadyOpen' });

	await first.close();
	await runtime.dispose();
});

test('opening waits for admission and rolls back a failed constructor', async () => {
	const runtime = createMemoryRuntime();
	const gate = Promise.withResolvers<void>();
	let released = false;
	const opening = openApp(definition, {
		runtime: {
			...runtime,
			async claim(...args) {
				const owned = expectOk(await runtime.claim(...args));
				await gate.promise;
				return Ok({
					release() {
						released = true;
						owned.release();
					},
				});
			},
			blobs() {
				throw new Error('construction failed');
			},
		},
	});
	void opening.catch(() => {});
	await expect(runtime.dispose()).rejects.toThrow('open Apps');
	expect(released).toBe(false);
	gate.resolve();
	await expect(opening).rejects.toThrow('construction failed');
	expect(released).toBe(true);
	await runtime.dispose();
});

test('failed document cleanup retains runtime admission and refuses disposal', async () => {
	const runtime = createMemoryRuntime();
	let cleanupAttempts = 0;
	const app = await openApp(definition, {
		runtime: {
			...runtime,
			async data(...args) {
				const backing = expectOk(await runtime.data(...args));
				return Ok({
					...backing,
					async dispose() {
						cleanupAttempts++;
						await backing.dispose?.();
						throw new Error('cleanup failed');
					},
				});
			},
		},
	});

	const terminal = app.close();
	expect(app.close()).toBe(terminal);
	await expect(terminal).rejects.toThrow('cleanup failed');
	await expect(runtime.dispose()).rejects.toThrow('open Apps');
	const duplicate = openApp(definition, { runtime });
	await expect(duplicate).rejects.toMatchObject({ name: 'AlreadyOpen' });

	expect(app.close()).toBe(terminal);
	await expect(app.close()).rejects.toThrow('cleanup failed');
	expect(cleanupAttempts).toBe(1);
	await expect(runtime.dispose()).rejects.toThrow('open Apps');
});

test('different Apps observe the shared memory AI catalog without a lock simulator', async () => {
	const runtime = createMemoryRuntime();
	const first = await openApp(definition, { runtime });
	const other = await openApp(
		defineApp({ ...definition, id: 'test.other-runtime-app' }),
		{ runtime },
	);

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
	const app = await openApp(definition, { runtime: { ...runtime, ai } });

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

for (const cleanupFails of [false, true]) {
	test(`a throwing backing getter rolls back known storage (cleanup fails: ${cleanupFails})`, async () => {
		const runtime = createMemoryRuntime();
		let disposals = 0;
		const opening = openApp(definition, {
			runtime: {
				...runtime,
				async data(...args) {
					const backing = expectOk(await runtime.data(...args));
					return Ok({
						...backing,
						get loaded(): typeof backing.loaded {
							throw new Error('Hydration failed');
						},
						async dispose() {
							disposals++;
							await backing.dispose?.();
							if (cleanupFails) throw new Error('Rollback failed');
						},
					});
				},
			},
		});
		await expect(opening).rejects.toMatchObject(
			cleanupFails
				? { name: 'AggregateError', cause: { name: 'StorageFailed' } }
				: { name: 'StorageFailed' },
		);
		expect(disposals).toBe(1);
		if (cleanupFails) {
			await expect(openApp(definition, { runtime })).rejects.toMatchObject({
				name: 'AlreadyOpen',
			});
			await expect(runtime.dispose()).rejects.toThrow('open Apps');
		} else {
			const reopened = await openApp(definition, { runtime });
			await reopened.close();
			await runtime.dispose();
		}
	});
}

for (const cleanupFails of [false, true]) {
	test(`AI construction rolls back its acquired catalog (cleanup fails: ${cleanupFails})`, async () => {
		const runtime = createMemoryRuntime();
		let disposals = 0;
		const failure = new Error('Subscription failed');
		const opening = openApp(definition, {
			runtime: {
				...runtime,
				ai: {
					...runtime.ai,
					connections(...args) {
						const catalog = runtime.ai.connections!(...args);
						return {
							...catalog,
							subscribe() {
								throw failure;
							},
							async close() {
								disposals++;
								await catalog.close();
								if (cleanupFails) throw new Error('Catalog cleanup failed');
							},
						};
					},
				},
			},
		});
		if (cleanupFails) {
			await expect(opening).rejects.toMatchObject({
				name: 'AggregateError',
				cause: failure,
			});
			await expect(openApp(definition, { runtime })).rejects.toMatchObject({
				name: 'AlreadyOpen',
			});
		} else {
			await expect(opening).rejects.toBe(failure);
			const reopened = await openApp(definition, { runtime });
			await reopened.close();
			await runtime.dispose();
		}
		expect(disposals).toBe(1);
	});
}
