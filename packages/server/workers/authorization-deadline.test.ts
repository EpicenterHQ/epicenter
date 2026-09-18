/**
 * Socket authorization deadlines in the deployed authority under workerd.
 *
 * Admission grants 600 seconds from the server clock. Cursor writes and real
 * hibernation preserve that grant; late alarms cannot permit data after expiry.
 * The idle test exercises a real scheduled alarm with a shortened attachment.
 */
import {
	env,
	evictDurableObject,
	runDurableObjectAlarm,
	runInDurableObject,
} from 'cloudflare:test';
import {
	decodeFrame,
	encodeFrame,
	type Frame,
	openCurrentAuthority,
} from '@epicenter/app/sync';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from '@epicenter/sqlite/durable-object';
import {
	bearerSubprotocol,
	formatSubprotocols,
	MAIN_SUBPROTOCOL,
} from '@epicenter/sync';
import { readCurrentDownload } from '@epicenter/sync/current-download';
import { Hono } from 'hono';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { expectOk } from 'wellcrafted/testing';
import { createEnvTokenResolver } from '../src/auth/instance-token.js';
import type { GenerationsLedger } from '../src/store-sync/generations.js';
import { mountStoreSyncApp } from '../src/store-sync/mount.js';
import type { Env } from '../src/types.js';

afterEach(() => vi.restoreAllMocks());

function authority() {
	return env.STORE_AUTHORITY.get(env.STORE_AUTHORITY.newUniqueId());
}

async function connect(stub: ReturnType<typeof authority>, query = '') {
	const initialized = await stub.fetch('https://authority.test/', {
		method: 'POST',
		body: new Uint8Array([42]),
	});
	expect(initialized.status).toBe(200);
	await initialized.arrayBuffer();
	const response = await stub.fetch(
		`https://authority.test/?generation=1&cursor=1&${query}`,
		{
			headers: {
				Upgrade: 'websocket',
				'epicenter-authorized-until': String(Number.MAX_SAFE_INTEGER),
			},
		},
	);
	expect(response.status).toBe(101);
	const socket = response.webSocket!;
	const frames: Frame[] = [];
	const closed = new Promise<CloseEvent>((resolve) => {
		socket.addEventListener('close', (event) => {
			socket.close();
			resolve(event);
		});
	});
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
	return {
		socket,
		frames,
		closed,
		push(submission = 1) {
			socket.send(
				encodeFrame({
					kind: 'push',
					submission,
					chunk: 0,
					chunks: 1,
					bytes: new Uint8Array([submission]),
				}),
			);
		},
	};
}

async function attachments(stub: ReturnType<typeof authority>) {
	return runInDurableObject(stub, (_instance, state) =>
		state.getWebSockets().map(
			(socket) =>
				socket.deserializeAttachment() as {
					cursor: number;
					generation: number;
					authorizedUntil: number;
				},
		),
	);
}

it('grants exactly 600 seconds from admission and ignores request deadlines', async () => {
	const now = Date.now();
	vi.spyOn(Date, 'now').mockReturnValue(now);
	const stub = authority();
	await connect(stub, `authorizedUntil=${Number.MAX_SAFE_INTEGER}&expiresAt=0`);
	expect(await attachments(stub)).toEqual([
		{ generation: 1, cursor: 1, authorizedUntil: now + 600_000 },
	]);
	expect(
		await runInDurableObject(stub, (_instance, state) =>
			state.storage.getAlarm(),
		),
	).toBe(now + 600_000);
});

it('preserves the original deadline through cursor writes and real hibernation', async () => {
	const now = Date.now();
	const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
	const stub = authority();
	const peer = await connect(stub);
	peer.push();
	await vi.waitFor(() =>
		expect(peer.frames).toContainEqual({ kind: 'ack', submission: 1, seq: 2 }),
	);
	expect(await attachments(stub)).toEqual([
		{ generation: 1, cursor: 2, authorizedUntil: now + 600_000 },
	]);
	await evictDurableObject(stub);
	clock.mockReturnValue(now + 599_999);
	peer.push(2);
	await vi.waitFor(() =>
		expect(peer.frames).toContainEqual({ kind: 'ack', submission: 2, seq: 3 }),
	);
	expect(await attachments(stub)).toEqual([
		{ generation: 1, cursor: 3, authorizedUntil: now + 600_000 },
	]);
	clock.mockReturnValue(now + 600_000);
	peer.push(3);
	expect((await peer.closed).code).toBe(1008);
	const fresh = await connect(stub);
	await vi.waitFor(() =>
		expect(fresh.frames.filter((frame) => frame.kind === 'entry')).toHaveLength(
			2,
		),
	);
	expect(
		fresh.frames
			.filter((frame) => frame.kind === 'entry')
			.map((frame) => frame.seq),
	).toEqual([2, 3]);
});

it('blocks outgoing relay to an expired socket before a delayed alarm runs', async () => {
	const now = Date.now();
	const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
	const stub = authority();
	const expired = await connect(stub);
	clock.mockReturnValue(now + 300_000);
	const writer = await connect(stub);
	clock.mockReturnValue(now + 600_000);
	writer.push();
	await vi.waitFor(() =>
		expect(writer.frames).toContainEqual({
			kind: 'ack',
			submission: 1,
			seq: 2,
		}),
	);
	expect((await expired.closed).code).toBe(1008);
	expect(expired.frames).toEqual([{ kind: 'admitted' }]);
});

it('refuses catch-up on wake for expired and missing authorization attachments', async () => {
	const now = Date.now();
	const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
	const stub = authority();
	const expired = await connect(stub);
	const legacy = await connect(stub);
	await runInDurableObject(stub, (_instance, state) => {
		state.getWebSockets()[1]!.serializeAttachment({ cursor: 0 });
	});
	// Commit catch-up work without delivering it to the open sockets.
	await runInDurableObject(stub, (_instance, state) => {
		const sqlite = createDurableObjectSqliteAdapter(
			state.storage as unknown as DurableObjectSqliteStorage,
		);
		expectOk(
			openCurrentAuthority({ sqlite })
				.bind(1)
				.append(new Uint8Array([43])),
		);
	});
	await evictDurableObject(stub);
	clock.mockReturnValue(now + 600_000);
	await (await stub.fetch('https://authority.test/')).arrayBuffer();
	expect((await expired.closed).code).toBe(1008);
	expect((await legacy.closed).code).toBe(1008);
	expect(expired.frames).toEqual([{ kind: 'admitted' }]);
	expect(legacy.frames).toEqual([{ kind: 'admitted' }]);
});

it('alarm expires the earliest peer after hibernation and reschedules the remaining peer', async () => {
	const now = Date.now();
	const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
	const stub = authority();
	const first = await connect(stub);
	clock.mockReturnValue(now + 100_000);
	const second = await connect(stub);
	expect(
		await runInDurableObject(stub, (_instance, state) =>
			state.storage.getAlarm(),
		),
	).toBe(now + 600_000);
	await evictDurableObject(stub);
	clock.mockReturnValue(now + 600_000);
	expect(await runDurableObjectAlarm(stub)).toBe(true);
	expect((await first.closed).code).toBe(1008);
	expect(second.socket.readyState).toBe(WebSocket.OPEN);
	expect(
		await runInDurableObject(stub, (_instance, state) =>
			state.storage.getAlarm(),
		),
	).toBe(now + 700_000);
	clock.mockReturnValue(now + 700_000);
	expect(await runDurableObjectAlarm(stub)).toBe(true);
	expect((await second.closed).code).toBe(1008);
	expect(await runDurableObjectAlarm(stub)).toBe(false);
});

it('a scheduled alarm closes an idle hibernating socket without incoming traffic', async () => {
	const stub = authority();
	const peer = await connect(stub);
	await runInDurableObject(stub, async (_instance, state) => {
		const socket = state.getWebSockets()[0]!;
		const authorizedUntil = Date.now() + 1_000;
		socket.serializeAttachment({
			...socket.deserializeAttachment(),
			authorizedUntil,
		});
		await state.storage.setAlarm(authorizedUntil);
	});
	await evictDurableObject(stub);
	const close = await peer.closed;
	expect(close.code).toBe(1008);
	expect(close.reason).toBe('socket authorization expired');
	expect(peer.frames).toEqual([{ kind: 'admitted' }]);
});

it('closing the earliest peer moves the alarm, and closing the last removes it', async () => {
	const now = Date.now();
	const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
	const stub = authority();
	const first = await connect(stub);
	clock.mockReturnValue(now + 100_000);
	const second = await connect(stub);
	first.socket.close();
	await first.closed;
	expect(
		await runInDurableObject(stub, (_instance, state) =>
			state.storage.getAlarm(),
		),
	).toBe(now + 700_000);
	second.socket.close();
	await second.closed;
	expect(
		await runInDurableObject(stub, (_instance, state) =>
			state.storage.getAlarm(),
		),
	).toBeNull();
});

it('a valid bearer can reconnect through the real mount after socket expiry', async () => {
	const now = Date.now();
	const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
	const stub = authority();
	const bindings = env as Cloudflare.Env & {
		GENERATIONS_LEDGER: DurableObjectNamespace<GenerationsLedger>;
	};
	const ledger = bindings.GENERATIONS_LEDGER.get(
		bindings.GENERATIONS_LEDGER.newUniqueId(),
	);
	const app = new Hono<Env>();
	const token = 'test-only-static-instance-token';
	mountStoreSyncApp(app, {
		resolveBearerPrincipal: createEnvTokenResolver(token),
		resolveStore: () => ({ authority: () => stub, ledger: () => ledger }),
	});
	const seeded = await app.request(
		'/api/libraries/so.epicenter.storeprobe/personal/data/so.epicenter.storeprobe/current',
		{
			method: 'POST',
			headers: { authorization: `Bearer ${token}` },
			body: new Uint8Array([42]),
		},
	);
	expect(seeded.status).toBe(200);
	expect((await readCurrentDownload(seeded)).snapshot.bytes).toEqual(
		new Uint8Array([42]),
	);
	const url =
		'/api/store/v1/sync?appId=so.epicenter.storeprobe&library=personal&dataId=so.epicenter.storeprobe&generation=1&cursor=1';
	const upgrade = (bearer: string) =>
		app.request(url, {
			headers: {
				Upgrade: 'websocket',
				'sec-websocket-protocol': formatSubprotocols([
					MAIN_SUBPROTOCOL,
					bearerSubprotocol(bearer),
				]),
			},
		});
	expect((await upgrade('wrong-token')).status).toBe(401);
	const admitted = await upgrade(token);
	expect(admitted.status).toBe(101);
	const socket = admitted.webSocket!;
	socket.accept();
	const closed = new Promise<CloseEvent>((resolve) =>
		socket.addEventListener('close', (event) => {
			socket.close();
			resolve(event);
		}),
	);
	clock.mockReturnValue(now + 600_000);
	await runDurableObjectAlarm(stub);
	expect((await closed).code).toBe(1008);
	const renewed = await upgrade(token);
	expect(renewed.status).toBe(101);
	renewed.webSocket!.accept();
	const reclosed = new Promise<void>((resolve) =>
		renewed.webSocket!.addEventListener('close', () => resolve()),
	);
	renewed.webSocket!.close();
	await reclosed;
});
