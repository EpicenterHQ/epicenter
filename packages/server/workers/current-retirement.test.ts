/**
 * Current-generation admission survives real Durable Object eviction. Replacement
 * is exercised inside the test owner, with no restore endpoint: retained sockets
 * and reconnecting old generations cannot write into the replacement log.
 */
import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import {
	decodeFrame,
	encodeFrame,
	type Frame,
	openCurrentAuthority,
} from '@epicenter/data/sync';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from '@epicenter/sqlite/durable-object';
import { readCurrentDownload } from '@epicenter/sync/current-download';
import { expect, onTestFinished, test, vi } from 'vitest';
import { expectOk } from 'wellcrafted/testing';

async function setup() {
	const stub = env.STORE_AUTHORITY.get(env.STORE_AUTHORITY.newUniqueId());
	const initialized = await stub.fetch('https://authority.test/', {
		method: 'POST',
		body: new Uint8Array([1]),
	});
	expect(initialized.status).toBe(200);
	await initialized.arrayBuffer();
	const inside = <T>(
		run: (authority: ReturnType<typeof openCurrentAuthority>) => T,
	) =>
		runInDurableObject(stub, (_instance, state) =>
			run(
				openCurrentAuthority({
					sqlite: createDurableObjectSqliteAdapter(
						state.storage as unknown as DurableObjectSqliteStorage,
					),
				}),
			),
		);
	async function connect(generation: number, cursor = 1) {
		const response = await stub.fetch(
			`https://authority.test/?generation=${generation}&cursor=${cursor}`,
			{ headers: { Upgrade: 'websocket' } },
		);
		expect(response.status).toBe(101);
		const socket = response.webSocket!;
		const frames: Frame[] = [];
		const closed = new Promise<CloseEvent>((resolve) =>
			socket.addEventListener('close', (event) => {
				socket.close();
				resolve(event);
			}),
		);
		socket.addEventListener('message', (event) => {
			frames.push(
				expectOk(decodeFrame(new Uint8Array(event.data as ArrayBuffer))),
			);
		});
		socket.accept();
		onTestFinished(async () => {
			socket.close();
			await closed;
		});
		return { socket, frames, closed };
	}
	async function replace() {
		return inside(async (authority) => {
			const { generation, head } = authority.capture();
			const prepared = await authority.prepareActivation({
				operation: crypto.randomUUID(),
				expected: { generation, head },
				bytes: new Uint8Array([2]),
			});
			return prepared.activate();
		});
	}
	return { stub, inside, connect, replace };
}

test('a retained socket cannot finish an old partial submission after replacement', async () => {
	const { connect, replace, inside } = await setup();
	const peer = await connect(1);
	await vi.waitFor(() => expect(peer.frames).toEqual([{ kind: 'admitted' }]));
	peer.socket.send(
		encodeFrame({
			kind: 'push',
			submission: 1,
			chunk: 0,
			chunks: 2,
			bytes: new Uint8Array([5]),
		}),
	);
	expect(await replace()).toMatchObject({ status: 'activated', generation: 2 });
	peer.socket.send(
		encodeFrame({
			kind: 'push',
			submission: 1,
			chunk: 1,
			chunks: 2,
			bytes: new Uint8Array([6]),
		}),
	);
	await vi.waitFor(() =>
		expect(peer.frames).toContainEqual({ kind: 'retired' }),
	);
	expect(peer.frames.some((frame) => frame.kind === 'ack')).toBe(false);
	expect(await inside((authority) => authority.capture())).toMatchObject({
		generation: 2,
		head: 1,
		snapshot: { bytes: new Uint8Array([2]) },
		tail: [],
	});
});

test('eviction reconstructs the socket original generation and retires it before catch-up', async () => {
	const { stub, connect, replace, inside } = await setup();
	const peer = await connect(1);
	await vi.waitFor(() => expect(peer.frames).toEqual([{ kind: 'admitted' }]));
	expect(
		await runInDurableObject(stub, (_instance, state) =>
			state.getWebSockets()[0]!.deserializeAttachment(),
		),
	).toMatchObject({ generation: 1, cursor: 1 });
	expect(await replace()).toMatchObject({ status: 'activated', generation: 2 });
	await evictDurableObject(stub);
	// A real socket event wakes the object and exercises attachment reconstruction.
	peer.socket.send(
		encodeFrame({
			kind: 'push',
			submission: 1,
			chunk: 0,
			chunks: 1,
			bytes: new Uint8Array([9]),
		}),
	);
	await peer.closed;
	expect(peer.frames).toEqual([{ kind: 'admitted' }, { kind: 'retired' }]);
	expect(await inside((authority) => authority.capture())).toMatchObject({
		generation: 2,
		head: 1,
		tail: [],
	});
	const stale = await connect(1);
	await stale.closed;
	expect(stale.frames).toEqual([{ kind: 'retired' }]);
	const current = await connect(2);
	await vi.waitFor(() =>
		expect(current.frames).toEqual([{ kind: 'admitted' }]),
	);
});

test('current download includes every accepted tail update before the next socket opens', async () => {
	const { stub, connect, inside } = await setup();
	await inside((authority) =>
		expectOk(authority.bind(1).append(new Uint8Array([8]))),
	);
	const response = await stub.fetch('https://authority.test/', {
		method: 'POST',
		body: new Uint8Array([99]),
	});
	expect(response.headers.get('epicenter-generation')).toBe('1');
	expect(response.headers.get('epicenter-log-position')).toBe('2');
	expect(await readCurrentDownload(response)).toEqual({
		generation: 1,
		head: 2,
		snapshot: { position: 1, bytes: new Uint8Array([1]) },
		tail: [{ seq: 2, bytes: new Uint8Array([8]) }],
	});
	const peer = await connect(1, 2);
	await vi.waitFor(() => expect(peer.frames).toEqual([{ kind: 'admitted' }]));
});
