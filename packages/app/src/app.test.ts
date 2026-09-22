/**
 * Personal store identity and lifecycle tests.
 *
 * Verifies the clean-break API owns captured-account acquisition, readiness, and closure.
 * Reopening fake IndexedDB proves rows survive a handle lifetime, not a browser restart.
 */
import { expect, test } from 'bun:test';
import { defineTable, field, plainText } from '@epicenter/app';
import type { Account } from '@epicenter/auth';
import { asPrincipalId } from '@epicenter/principal';
import { createCurrentDownloadResponse } from '@epicenter/sync/current-download';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { encodeFrame } from './data/sync/frames.js';
import { defineApp } from './index.js';
import { openLocal, openPersonal } from './open-store.js';
import { createMemoryStoreRuntime } from './testing.js';

const definition = defineApp({
	id: 'so.epicenter.app-test',
	kv: {},
	tables: {
		notes: defineTable({ title: field.string(), content: plainText() }),
		recordings: defineTable({ audio: field.string(), content: plainText() }),
	},
});

/** The authority returns the stored seed bytes after minting a generation. */
function createGenerationFetch(): Account['fetch'] {
	let state: Blob | null = null;
	return async (_input, init) => {
		if (init?.method !== 'POST') throw new Error('Expected current download');
		state ??= await new Response(init.body).blob();
		return createCurrentDownloadResponse({
			generation: 1,
			head: 1,
			snapshot: {
				position: 1,
				bytes: new Uint8Array(await state.arrayBuffer()),
			},
			tail: [],
		});
	};
}

test('Personal acquisition hydrates the existing handles and survives refused sync', async () => {
	const runtime = createMemoryStoreRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const create = (account: Account) =>
		openPersonal(definition, { account, runtime });
	const seed = await openLocal(definition, { runtime });

	seed.tables.notes.create({ title: 'from the account' });
	const snapshot = seed.encodeStateSince();
	await seed.close();
	let fetches = 0;
	let dials = 0;
	const account: Account = {
		authorityId: 'test-authority',
		principalId: asPrincipalId('alice'),
		baseURL: 'https://example.test',
		async fetch() {
			fetches += 1;
			return createCurrentDownloadResponse({
				generation: 1,
				head: 1,
				snapshot: { position: 1, bytes: snapshot },
				tail: [],
			});
		},
		async openWebSocket() {
			dials += 1;
			throw new Error('Offline');
		},
		async getProfile() {
			throw new Error('Opening data must not fetch a profile.');
		},
	};
	const app = await create(account);
	const notes = app.tables.notes;
	expect(app.identity).toEqual({
		authorityId: 'test-authority',
		principalId: account.principalId,
	});

	expect(app.tables.notes).toBe(notes);
	expect(notes.rows[0]?.title).toBe('from the account');
	expect(fetches).toBe(1);
	expect(dials).toBe(1);
	notes.create({ title: 'still editable' });
	await app.close();

	const reopened = await create(account);

	expect(fetches).toBe(1);
	expect(reopened.tables.notes.rows).toHaveLength(2);
	await reopened.close();
});

test('invalid definitions throw before opening storage', async () => {
	// Runtime validation also refuses defaults hidden by a broad schema type.
	const invalid = () =>
		defineApp({
			id: 'so.epicenter.app-test',
			tables: {},
			kv: {
				name: { ...field.string(), default: 'invalid' } as ReturnType<
					typeof field.string
				>,
			},
		});
	expect(invalid).toThrow();
});

test('Personal retirement retains its claim after terminal invalidation failure', async () => {
	const runtime = createMemoryStoreRuntime();
	const appId = `test.${crypto.randomUUID()}`;
	const events = new EventTarget();
	const socket = Object.assign(events, {
		readyState: 1,
		binaryType: '',
		send() {},
		close() {},
	}) as unknown as WebSocket;
	const invalidation = Promise.withResolvers<void>();
	let disposed = 0;
	const account: Account = {
		authorityId: 'retirement-test',
		principalId: asPrincipalId('alice'),
		baseURL: 'https://retirement.test',
		async fetch() {
			throw new Error('This test uses its isolated backing');
		},
		async openWebSocket() {
			return socket;
		},
		async getProfile() {
			throw new Error('Unused');
		},
	};
	const acquireData = runtime.data;
	runtime.data = async (definition, options) =>
		options.kind === 'local'
			? acquireData(definition, options)
			: Ok({
					durable: { commit() {} },
					loaded: { updates: [], outbox: [], cursor: 0, lastId: 0 },
					discard: () => invalidation.promise,
					dispose() {
						disposed += 1;
					},
					replication: {
						address: {
							baseURL: account.baseURL,
							dataId: definition.id,
							generation: 1,
						},
						transport: account,
					},
				});
	const fixtureDefinition = defineApp({ ...definition, id: appId });
	const openFixture = (account: Account) =>
		openPersonal(fixtureDefinition, { account, runtime });
	const app = await openFixture(account);
	try {
		await Bun.sleep(0);
		expect(app.signal.aborted).toBe(false);
		events.dispatchEvent(
			new MessageEvent('message', {
				data: encodeFrame({ kind: 'retired' }).buffer,
			}),
		);
		expect(app.signal.aborted).toBe(true);
		await new Promise<void>((resolve) => {
			if (app.signal.aborted) resolve();
			else
				app.signal.addEventListener('abort', () => resolve(), { once: true });
		});
		expect(disposed).toBe(0);
		expect(() => app.tables.notes.create({ title: 'late' })).toThrow();
		invalidation.reject(new Error('Invalidation failed'));
		await expect(app.close()).rejects.toThrow('Invalidation failed');
		expect(disposed).toBe(0);
		const duplicate = openFixture(account);
		await expect(duplicate).rejects.toMatchObject({ name: 'AlreadyOpen' });

		const terminal = app.close();
		expect(app.close()).toBe(terminal);
		await expect(terminal).rejects.toThrow('Invalidation failed');
		expect(disposed).toBe(0);
		await expect(runtime.dispose()).rejects.toThrow('open stores');
	} finally {
		invalidation.resolve();
		await app.close().catch(() => {});
	}
});

test('Personal retirement during attachment refuses readiness without auto-releasing its backing', async () => {
	const runtime = createMemoryStoreRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const invalidation = Promise.withResolvers<void>();
	let disposed = 0;
	const socket = {
		readyState: 1,
		binaryType: '',
		send() {},
		close() {},
		addEventListener(type: string, listener: EventListener) {
			if (type === 'message')
				listener(
					new MessageEvent('message', {
						data: encodeFrame({ kind: 'retired' }).buffer,
					}),
				);
		},
	} as unknown as WebSocket;
	const account: Account = {
		authorityId: 'retirement-during-attach',
		principalId: asPrincipalId('alice'),
		baseURL: 'https://retirement.test',
		async fetch() {
			throw new Error('Unused');
		},
		async openWebSocket() {
			return socket;
		},
		async getProfile() {
			throw new Error('Unused');
		},
	};
	const acquireData = runtime.data;
	runtime.data = async (definition, options) =>
		options.kind === 'local'
			? acquireData(definition, options)
			: Ok({
					durable: { commit() {} },
					loaded: { updates: [], outbox: [], cursor: 0, lastId: 0 },
					discard: () => invalidation.promise,
					dispose() {
						disposed += 1;
					},
					replication: {
						address: {
							baseURL: account.baseURL,
							dataId: definition.id,
							generation: 1,
						},
						transport: account,
					},
				});
	const appDefinition = defineApp({
		...definition,
		id: `test.${crypto.randomUUID()}`,
	});
	const app = openPersonal(appDefinition, { account, runtime });
	void app.catch(() => {});
	await Bun.sleep(0);
	expect(disposed).toBe(0);
	invalidation.resolve();
	await expect(app).rejects.toMatchObject({ name: 'ClosedWhileOpening' });
	expect(disposed).toBe(1);
});

test('replacing the Account cannot submit Alice pending Personal edits as Bob', async () => {
	const runtime = createMemoryStoreRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const { createSessionAuth } = await import('@epicenter/auth');
	const { decodeFrame } = await import('./data/sync/frames.js');
	const appId = `shared.${crypto.randomUUID()}`;
	let person = 'alice';
	const submissions: string[] = [];
	class Socket extends EventTarget {
		readyState = 0;
		binaryType = '';
		constructor(_url: string | URL, protocols?: string | string[]) {
			super();
			const offered = Array.isArray(protocols) ? protocols : [protocols];
			const actor = offered.find((value) => value?.startsWith('bearer.')) ?? '';
			this.send = (bytes: Uint8Array) => {
				const frame = expectOk(decodeFrame(bytes));
				if (frame.kind === 'push') submissions.push(actor);
			};
			setTimeout(() => {
				if (this.readyState !== 0) return;
				this.readyState = 1;
				this.dispatchEvent(new Event('open'));
				// Alice authors while her socket has not been admitted. Bob is admitted.
				if (actor.includes('bob'))
					this.dispatchEvent(
						new MessageEvent('message', {
							data: encodeFrame({ kind: 'admitted' }).buffer,
						}),
					);
			}, 0);
		}
		send(_bytes: Uint8Array) {}
		close() {
			this.readyState = 3;
			this.dispatchEvent(new Event('close'));
		}
	}
	const current = createGenerationFetch();
	const auth = createSessionAuth({
		authorityId: 'shared-replacement',
		baseURL: 'https://replace.test',
		persistedAuthStorage: {
			initial: { principalId: asPrincipalId('alice'), token: 'alice' },
			set() {},
		},
		launcher: {
			async startSignIn() {
				return { status: 'completed', token: person };
			},
		},
		WebSocket: Socket as unknown as typeof WebSocket,
		fetch: async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.pathname === '/api/session')
				return Response.json({ principalId: person });
			if (url.pathname === '/auth/sign-out') return new Response(null);
			return current(input, init);
		},
	});
	const fixtureDefinition = defineApp({ ...definition, id: appId });
	const openFixture = (account: Account) =>
		openPersonal(fixtureDefinition, { account, runtime });
	const state = auth.getState();
	if (state.status === 'signed-out') throw new Error('Expected cached Alice');
	const alice = state.account;
	const first = await openFixture(alice);

	first.tables.notes.create({
		title: 'Alice pending private queue',
	});
	person = 'bob';
	expectOk(await auth.startSignIn());
	await first.close();
	await expect(alice.fetch('/api/session')).rejects.toMatchObject({
		name: 'AbortError',
	});
	const bobState = auth.getState();
	if (bobState.status === 'signed-out') throw new Error('Expected Bob');
	const second = await openFixture(bobState.account);
	try {
		expect(second.tables.notes.rows).toHaveLength(0);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(submissions).toEqual([]);
	} finally {
		await second.close();
		auth[Symbol.dispose]();
	}
});
