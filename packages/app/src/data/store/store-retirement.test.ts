/**
 * Store retirement owns the synchronous write fence and retains its backing
 * until invalidation succeeds. These tests exercise the actual sync adapter,
 * retained handles, failed invalidation, and close races over real SQLite.
 * Browser transaction interruption is covered by the generation-cache evidence.
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { defineStore, defineTable, field, plainText } from '@epicenter/app';
import { compileData } from '@epicenter/app/definition';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { encodeFrame } from '../sync/frames.js';
import { createSqliteDurablePort } from './log.js';
import { createStoreOverPort, StoreUnusableError } from './store.js';

const definition = expectOk(
	compileData(
		defineStore({
			id: 'so.epicenter.retirement-test',
			kv: { theme: field.string() },
			tables: {
				notes: defineTable({
					fields: { title: field.string() },
					body: plainText(),
				}),
			},
		}),
	),
);

function setup(retireDuringAttach = false, supportsDiscard = true) {
	const raw = new Database(':memory:');
	const sqlite = createBunSqliteAdapter(raw);
	const port = createSqliteDurablePort({ sqlite });
	const events = new EventTarget();
	let gate = Promise.withResolvers<void>();
	let fenced = false;
	let disposed = 0;
	let commits = 0;
	const receive = () =>
		events.dispatchEvent(
			new MessageEvent('message', {
				data: encodeFrame({ kind: 'retired' }).buffer,
			}),
		);
	const socket = {
		readyState: 1,
		binaryType: '',
		addEventListener(type: string, listener: EventListener) {
			events.addEventListener(type, listener);
			if (type === 'message' && retireDuringAttach) receive();
		},
		send() {},
		close() {},
	} as unknown as WebSocket;
	const parts = createStoreOverPort({
		definition,
		async acquire() {
			return Ok({
				loaded: port.load(),
				durable: {
					commit(ops: Parameters<typeof port.commit>[0]) {
						if (fenced) throw new Error('Retired backing is fenced');
						commits += 1;
						return port.commit(ops);
					},
				},
				...(supportsDiscard
					? {
							discard() {
								fenced = true;
								return gate.promise.then(() =>
									sqlite.run('DELETE FROM _updates'),
								);
							},
						}
					: {}),
				dispose() {
					disposed += 1;
				},
				replication: {
					address: {
						baseURL: 'https://example.test',
						dataId: definition.id,
						generation: 1,
					},
					transport: {
						async openWebSocket() {
							return socket;
						},
					},
				},
			});
		},
	});
	return Object.assign(parts, {
		receive,
		invalidated: () => gate.resolve(),
		fail: () => gate.reject(new Error('invalidation failed')),
		retry() {
			gate = Promise.withResolvers<void>();
		},
		fenced: () => fenced,
		disposed: () => disposed,
		commits: () => commits,
		async [Symbol.asyncDispose]() {
			gate.resolve();
			await parts.close().catch(() => {});
			raw.close();
		},
	});
}

test('retirement fences retained writes before notification and close waits for invalidation', async () => {
	await using context = setup();
	expectOk(await context.ready);
	await new Promise<void>((resolve) => setImmediate(resolve));
	const update = context.view.kv.update;
	context.receive();
	expect(context.fenced()).toBe(true);
	expect(context.lifetime.signal.aborted).toBe(true);
	expect(() => update({ theme: 'late edit' })).toThrow(StoreUnusableError);
	let closed = false;
	const closing = context.close().then(() => {
		closed = true;
	});
	await Promise.resolve();
	expect(context.disposed()).toBe(0);
	expect(closed).toBe(false);
	context.invalidated();
	await closing;
	expect(context.disposed()).toBe(1);
	expect(context.commits()).toBe(0);
});

test('invalidation can fail before observation and retry without reopening writes or releasing ownership', async () => {
	await using context = setup();
	expectOk(await context.ready);
	await new Promise<void>((resolve) => setImmediate(resolve));
	context.receive();
	context.fail();
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(context.lifetime.signal.aborted).toBe(true);
	await expect(context.close()).rejects.toThrow('invalidation failed');
	expect(context.disposed()).toBe(0);
	context.retry();
	expect(context.canRetryClose).toBe(true);
	expect(() => context.view.kv.update({ theme: 'still fenced' })).toThrow(
		StoreUnusableError,
	);
	const closing = context.close();
	context.invalidated();
	await closing;
	expect(context.disposed()).toBe(1);
});

test('retirement during attachment never turns readiness cleanup into backing release', async () => {
	await using context = setup(true);
	await context.ready;
	expect(context.lifetime.signal.aborted).toBe(true);
	expect(context.isRetired).toBe(true);
	expect(context.disposed()).toBe(0);
	expect(() => context.lifetime.assertUsable()).toThrow(StoreUnusableError);
	context.invalidated();
	await context.close();
	expect(context.disposed()).toBe(1);
});

test('a close requested by lifetime abortion cannot pass the invalidation gate', async () => {
	await using context = setup();
	expectOk(await context.ready);
	await new Promise<void>((resolve) => setImmediate(resolve));
	let closing: Promise<void> | undefined;
	context.lifetime.signal.addEventListener('abort', () => {
		closing = context.close();
	});
	context.receive();
	expect(context.lifetime.signal.aborted).toBe(true);
	await Promise.resolve();
	expect(context.disposed()).toBe(0);
	context.invalidated();
	await closing;
	expect(context.disposed()).toBe(1);
});

test('a legacy backing without invalidation support remains unusable and unreleased after retirement', async () => {
	await using context = setup(false, false);
	expectOk(await context.ready);
	await new Promise<void>((resolve) => setImmediate(resolve));
	context.receive();
	expect(context.lifetime.signal.aborted).toBe(true);
	await expect(context.close()).rejects.toThrow(
		'does not support generation invalidation',
	);
	await expect(context.close()).rejects.toThrow(
		'does not support generation invalidation',
	);
	expect(context.disposed()).toBe(0);
	expect(() => context.view.kv.update({ theme: 'late' })).toThrow(
		StoreUnusableError,
	);
});
