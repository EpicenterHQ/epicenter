/**
 * Native SQL socket lifetimes.
 * Verifies physical cleanup after disconnect, response correlation, permanent
 * handle retirement, and secrets continuing over HTTP after SQL closes.
 */
import { expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createDesktopDevice, createDesktopSqliteOwner } from './desktop.js';
import { secretLabel } from './index.js';
import {
	createDeviceDispatcher,
	createSqliteOwner,
	type AppSqliteRequest,
	type DeviceSqliteOwner,
	type SqliteBackend,
} from './owner.js';

import { installTestLocks } from './test-locks.js';
installTestLocks();

const appId = 'so.epicenter.test';
function setup() {
	const calls: string[] = [];
	const backend: SqliteBackend = {
		async open() {
			return {
				async query() {
					return Ok({ columns: [], rows: [], truncated: false });
				},
				async run() {
					calls.push('run');
					return Ok({ changes: 1 });
				},
				async all() {
					return Ok([]);
				},
				async batch() {
					return Ok({ changes: [] });
				},
				async close() {
					calls.push('close');
				},
			};
		},
		async delete() {
			calls.push('delete');
		},
	};
	const owner = createSqliteOwner(backend);
	return { calls, backend, owner };
}

function socketsFor(owner: DeviceSqliteOwner) {
	const sockets: Socket[] = [];
	class Socket {
		onopen?: () => void;
		onclose?: () => void;
		onerror?: () => void;
		onmessage?: (event: { data: string }) => void;
		closed = false;
		disposal: Promise<void> | undefined;
		requests: AppSqliteRequest[] = [];
		dispatch = createDeviceDispatcher(owner);
		constructor(public url: string) {
			sockets.push(this);
			queueMicrotask(() => this.onopen?.());
		}
		send(text: string) {
			const { id, request } = JSON.parse(text) as {
				id: number;
				request: AppSqliteRequest;
			};
			this.requests.push(request);
			void this.dispatch.request(request).then(
				(response) => this.receive({ id, response }),
				(cause: unknown) =>
					this.receive({
						id,
						failure: cause instanceof Error ? cause.message : String(cause),
					}),
			);
		}
		receive(frame: unknown) {
			if (!this.closed) this.onmessage?.({ data: JSON.stringify(frame) });
		}
		close() {
			if (this.closed) return;
			this.closed = true;
			this.disposal = this.dispatch.close();
			void this.disposal.catch(() => undefined);
			this.onclose?.();
		}
	}
	return { sockets, webSocket: Socket as unknown as typeof WebSocket };
}

test('SQL uses one lifetime socket and secrets survive its acknowledged close', async () => {
	const { owner, calls } = setup();
	const transport = socketsFor(owner);
	const http: string[] = [];
	const storage = createDesktopDevice({
		appId,
		baseURL: 'https://epicenter.test',
		webSocket: transport.webSocket,
		fetch: (async (_url, init) => {
			const request = JSON.parse(String(init?.body));
			http.push(request.kind);
			return Response.json({ kind: request.kind, value: 'refresh' });
		}) as typeof fetch,
	});
	expect(transport.sockets).toHaveLength(0);
	const database = expectOk(await storage.sqlite.open('mail'));
	expectOk(await database.run('SELECT 1'));
	await storage.close();
	expectErr(await database.run('SELECT 1'));
	expectOk(await storage.secrets.put(secretLabel('account-1'), 'refresh'));
	expect(expectOk(await storage.secrets.get(secretLabel('account-1')))).toBe(
		'refresh',
	);
	expect(http).toEqual(['secret-put', 'secret-get']);
	expect(calls).toEqual(['run', 'close']);
	expect(transport.sockets).toHaveLength(1);
	expect(transport.sockets[0]?.url).toBe(
		'wss://epicenter.test/api/device/sqlite',
	);
	expect(transport.sockets[0]?.closed).toBe(true);
	expect(transport.sockets[0]?.requests.map(({ kind }) => kind)).toEqual([
		'sqlite-acquire',
		'sqlite-open',
		'sqlite-run',
		'sqlite-close',
	]);
});

test('disconnect during acquisition rejects the caller and drains the late acquired lifetime', async () => {
	const { owner } = setup();
	const gate = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const transport = socketsFor({
		async acquire(...args) {
			started.resolve();
			await gate.promise;
			return owner.acquire(...args);
		},
	});
	const desktop = createDesktopSqliteOwner({
		baseURL: 'http://epicenter.test',
		webSocket: transport.webSocket,
	});
	const acquiring = desktop.acquire(appId, { library: 'local' });
	void acquiring.catch(() => undefined);
	await started.promise;
	transport.sockets[0]!.close();
	await expect(acquiring).rejects.toMatchObject({ name: 'StorageFailed' });
	gate.resolve();
	await transport.sockets[0]!.disposal;
	await (await owner.acquire(appId, { library: 'local' })).close();
	expect(transport.sockets).toHaveLength(1);
});

test('disconnect drains a delayed statement and retained handles never reconnect', async () => {
	const { owner, backend, calls } = setup();
	const gate = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const original = backend.open;
	backend.open = async (...args) => ({
		...(await original(...args)),
		async run() {
			started.resolve();
			await gate.promise;
			calls.push('finished');
			return Ok({ changes: 1 });
		},
	});
	const transport = socketsFor(owner);
	const desktop = createDesktopSqliteOwner({
		baseURL: 'http://epicenter.test',
		webSocket: transport.webSocket,
	});
	const lifetime = await desktop.acquire(appId, { library: 'local' });
	const database = await lifetime.open('mail');
	const pending = database.run('SELECT 1');
	await started.promise;
	transport.sockets[0]!.close();
	expectErr(await pending);
	expectErr(await database.all('SELECT 1'));
	await expect(lifetime.open('another')).rejects.toMatchObject({
		name: 'StorageFailed',
	});
	expect(transport.sockets).toHaveLength(1);
	expect(calls).toEqual([]);
	gate.resolve();
	await transport.sockets[0]!.disposal;
	expect(calls).toEqual(['finished', 'close']);
	const replacement = await desktop.acquire(appId, { library: 'local' });
	expect(transport.sockets).toHaveLength(2);
	expectErr(await database.all('SELECT 1'));
	await replacement.close();
});

test('an unknown response id retires the socket instead of settling another request', async () => {
	const { owner } = setup();
	const transport = socketsFor(owner);
	const lifetime = await createDesktopSqliteOwner({
		baseURL: 'http://epicenter.test',
		webSocket: transport.webSocket,
	}).acquire(appId, { library: 'local' });
	transport.sockets[0]!.receive({ id: -1, response: { kind: 'sqlite-close' } });
	await expect(lifetime.open('search')).rejects.toMatchObject({
		name: 'StorageFailed',
	});
	expect(transport.sockets[0]!.closed).toBe(true);
	expect(transport.sockets).toHaveLength(1);
	await transport.sockets[0]!.disposal;
});
