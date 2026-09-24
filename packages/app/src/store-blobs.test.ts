/**
 * Store-owned blob lifetime: joint acquisition settles late successes, preserves
 * failures and exclusion, fences borrowed methods, and isolates test runtimes.
 */
import { expect, test } from 'bun:test';
import { BlobStoreError } from '@epicenter/blobs';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { StoreError } from './data/store/store.js';
import { defineStore } from './index.js';
import { openLocal } from './open-store.js';
import { createRecorder } from './recorder.js';
import { createMemoryStoreRuntime } from './testing.js';

const definition = defineStore({ id: 'test.store-blobs', tables: {}, kv: {} });

test('stores own blob admission and close while isolated runtimes retain independent bytes', async () => {
	const first = createMemoryStoreRuntime();
	const second = createMemoryStoreRuntime();
	const a = await openLocal(definition, { runtime: first });
	const b = await openLocal(definition, { runtime: second });
	expect('close' in a.blobs).toBe(false);
	expect('signal' in a.blobs).toBe(false);
	const id = expectOk(await a.blobs.add(new Blob(['first'])));
	expect((await b.blobs.get(id)).error?.name).toBe('BlobNotFound');
	const retained = a.blobs.get;
	const closing = a.close();
	expect(a.close()).toBe(closing);
	expect(() => retained(id)).toThrow();
	await closing;
	const reopened = await openLocal(definition, { runtime: first });
	expect(await expectOk(await reopened.blobs.get(id)).text()).toBe('first');
	await Promise.all([reopened.close(), b.close()]);
	await Promise.all([first.dispose(), second.dispose()]);
});

for (const firstFailure of ['document', 'blob'] as const)
	test(`${firstFailure} failure waits for the other acquisition and closes its late success`, async () => {
		const runtime = createMemoryStoreRuntime();
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		let released = false;
		let settled = false;
		const opening = openLocal(definition, {
			runtime: {
				...runtime,
				async data(...args) {
					if (firstFailure === 'document')
						return StoreError.StorageFailed({
							cause: new Error('document refused'),
						});
					entered.resolve();
					await gate.promise;
					const backing = expectOk(await runtime.data(...args));
					return Ok({
						...backing,
						async dispose() {
							await backing.dispose?.();
							released = true;
						},
					});
				},
				async localBlobs(id, assertUsable) {
					if (firstFailure === 'blob')
						return BlobStoreError.BlobStoreFailed({
							cause: new Error('blob refused'),
						});
					entered.resolve();
					await gate.promise;
					const owner = expectOk(await runtime.localBlobs(id, assertUsable));
					return Ok({
						...owner,
						async close() {
							await owner.close();
							released = true;
						},
					});
				},
			},
		});
		void opening.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await entered.promise;
		await Bun.sleep(0);
		expect(settled).toBe(false);
		await expect(runtime.dispose()).rejects.toThrow('open stores');
		gate.resolve();
		await expect(opening).rejects.toBeDefined();
		expect(released).toBe(true);
		const next = await openLocal(definition, { runtime });
		await next.close();
		await runtime.dispose();
	});

test('opening preserves a document failure and late blob cleanup failure, retaining exclusion', async () => {
	const runtime = createMemoryStoreRuntime();
	const cleanup = new Error('blob cleanup uncertain');
	const gate = Promise.withResolvers<void>();
	const primary = StoreError.StorageFailed({
		cause: new Error('document refused'),
	});
	const opening = openLocal(definition, {
		runtime: {
			...runtime,
			async data() {
				return primary;
			},
			async localBlobs(id, assertUsable) {
				await gate.promise;
				const owner = expectOk(await runtime.localBlobs(id, assertUsable));
				return Ok({
					...owner,
					async close() {
						await owner.close();
						throw cleanup;
					},
				});
			},
		},
	});
	gate.resolve();
	const failure = await opening.catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(AggregateError);
	expect((failure as AggregateError).errors).toContain(primary.error);
	expect((failure as AggregateError).errors).toContain(cleanup);
	await expect(openLocal(definition, { runtime })).rejects.toMatchObject({
		name: 'AlreadyOpen',
	});
});

test('thrown blob acquisition retains exclusion after document cleanup', async () => {
	const runtime = createMemoryStoreRuntime();
	await expect(
		openLocal(definition, {
			runtime: {
				...runtime,
				async localBlobs() {
					throw new Error('unknown ownership');
				},
			},
		}),
	).rejects.toThrow();
	await expect(openLocal(definition, { runtime })).rejects.toMatchObject({
		name: 'AlreadyOpen',
	});
});

test('blob cleanup rejection is terminal and document cleanup is still completed', async () => {
	const runtime = createMemoryStoreRuntime();
	let released = false;
	const store = await openLocal(definition, {
		runtime: {
			...runtime,
			async data(...args) {
				const backing = expectOk(await runtime.data(...args));
				return Ok({
					...backing,
					async dispose() {
						await backing.dispose?.();
						released = true;
					},
				});
			},
			async localBlobs(id, assertUsable) {
				const owner = expectOk(await runtime.localBlobs(id, assertUsable));
				return Ok({
					...owner,
					close() {
						void owner.close();
						throw new Error('uncertain release');
					},
				});
			},
		},
	});
	const closing = store.close();
	expect(store.close()).toBe(closing);
	await expect(closing).rejects.toThrow('uncertain release');
	expect(released).toBe(true);
	await expect(openLocal(definition, { runtime })).rejects.toMatchObject({
		name: 'AlreadyOpen',
	});
});

test('store abort callbacks cannot publish bytes or acquire a recorder during close', async () => {
	const runtime = createMemoryStoreRuntime();
	const store = await openLocal(definition, { runtime });
	let addRefused = false;
	let recorderRefused = false;
	store.signal.addEventListener('abort', () => {
		try {
			void store.blobs.add(new Blob(['late']));
		} catch {
			addRefused = true;
		}
		try {
			createRecorder({ localBlobs: store.blobs });
		} catch (error) {
			recorderRefused =
				error instanceof Error && error.message === 'Store is closed.';
		}
	});
	await store.close();
	expect(addRefused).toBe(true);
	expect(recorderRefused).toBe(true);
	const reopened = await openLocal(definition, { runtime });
	expect(expectOk(await reopened.blobs.list()).items).toHaveLength(0);
	await reopened.close();
	await runtime.dispose();
});
