/**
 * Local store integration over isolated storage: pending admission and
 * failure-safe document ownership.
 */
import { expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { defineApp, defineTable, field } from './index.js';
import { openLocal } from './open-store.js';
import { createMemoryStoreRuntime } from './testing.js';

const definition = defineApp({
	id: 'test.complete-runtime',
	kv: {},
	tables: { notes: defineTable({ title: field.string() }) },
});

test('a rejected duplicate cannot release the incumbent', async () => {
	const runtime = createMemoryStoreRuntime();
	const first = await openLocal(definition, { runtime });
	const second = openLocal(definition, { runtime });

	await expect(second).rejects.toMatchObject({ name: 'AlreadyOpen' });

	await expect(runtime.dispose()).rejects.toThrow('open stores');
	const third = openLocal(definition, { runtime });
	await expect(third).rejects.toMatchObject({ name: 'AlreadyOpen' });

	await first.close();
	await runtime.dispose();
});

test('failed document cleanup retains runtime admission and refuses disposal', async () => {
	const runtime = createMemoryStoreRuntime();
	let cleanupAttempts = 0;
	const app = await openLocal(definition, {
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
	await expect(runtime.dispose()).rejects.toThrow('open stores');
	const duplicate = openLocal(definition, { runtime });
	await expect(duplicate).rejects.toMatchObject({ name: 'AlreadyOpen' });

	expect(app.close()).toBe(terminal);
	await expect(app.close()).rejects.toThrow('cleanup failed');
	expect(cleanupAttempts).toBe(1);
	await expect(runtime.dispose()).rejects.toThrow('open stores');
});
