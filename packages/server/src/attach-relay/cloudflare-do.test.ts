/**
 * `AttachRelay` Durable Object backend proof (ADR-0115): the Cloud transport.
 *
 * `cloud-attach.test.ts` proves the account-mediated invariant through the mount
 * over the Bun transport (resolver output -> stamped principal -> coordinator
 * partition). This file proves the same invariants ride the Cloudflare backend:
 * the `AttachRelay` Durable Object plus `createDurableObjectAttachRelay`, driven
 * through a fake `DurableObjectNamespace` of real DO instances.
 *
 * The two properties under test are the ones the DO layer owns:
 *
 *  - A host and a client of ONE `(principalId, hostId)` pair route to ONE DO, so
 *    the in-DO coordinator pairs them and forwards live bytes both ways. Because
 *    the registry stamps the server-resolved principal onto the forwarded URL,
 *    this holds even when the connect query claims a different principal.
 *  - A client whose server-resolved principal differs routes to a DIFFERENT DO
 *    (a different name), so it pairs with no host: HOST_NOT_FOUND. That is
 *    account isolation at the DO-routing layer.
 *
 * Bun's runtime provides no Cloudflare Workers globals, so we mock
 * `cloudflare:workers` (the `DurableObject` base) and shim `WebSocketPair` with a
 * cross-linked stub pair that dispatches `message`/`close` events between the two
 * halves, then drive the DO through its public `fetch()` (via the registry) and
 * inspect the stub sockets without changing production socket ownership.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { RELAY_CLOSE } from './contracts.js';

// ────────────────────────────────────────────────────────────────────────────
// CLOUDFLARE WORKERS SHIMS
// ────────────────────────────────────────────────────────────────────────────

type SocketEvent = { data?: string; code?: number; reason?: string };
type Listener = (event: SocketEvent) => void;
type EventType = 'message' | 'close' | 'error';

/**
 * A minimal standard-accept WebSocket half. `send`/`close` cross the wire to the
 * PEER half's listeners, so the coordinator's frames onto the server half arrive
 * at the client half the DO handed back (and vice versa). The coordinator's sends
 * also land in `sent`, and its closes in `closes`, so a test reads the server
 * half directly.
 */
class StubWebSocket {
	readyState = 1 /* OPEN */;
	accepted = false;
	peer!: StubWebSocket;
	sent: string[] = [];
	closes: Array<{ code: number; reason: string }> = [];
	readonly listeners: Record<EventType, Listener[]> = {
		message: [],
		close: [],
		error: [],
	};

	accept(): void {
		this.accepted = true;
	}

	addEventListener(type: EventType, fn: Listener): void {
		this.listeners[type].push(fn);
	}

	send(data: string): void {
		this.sent.push(data);
		for (const fn of this.peer.listeners.message) fn({ data });
	}

	close(code: number, reason: string): void {
		this.closes.push({ code, reason });
		this.readyState = 3 /* CLOSED */;
		for (const fn of this.peer.listeners.close) fn({ code, reason });
	}
}

const webSocketPairs: Array<{ client: StubWebSocket; server: StubWebSocket }> =
	[];

class StubWebSocketPair {
	0: StubWebSocket;
	1: StubWebSocket;
	constructor() {
		const client = new StubWebSocket();
		const server = new StubWebSocket();
		client.peer = server;
		server.peer = client;
		this[0] = client;
		this[1] = server;
		webSocketPairs.push({ client, server });
	}
}

// `WebSocketPair` is a Workers global the DO's `fetch` mints. Install this stub
// only around this file's own tests and restore the prior value afterward, so a
// sibling DO test's differently shaped `WebSocketPair` stub is never clobbered
// in the shared Bun test process.
let priorWebSocketPair: unknown;
beforeAll(() => {
	// biome-ignore lint/suspicious/noExplicitAny: globalThis shim
	priorWebSocketPair = (globalThis as any).WebSocketPair;
	// biome-ignore lint/suspicious/noExplicitAny: globalThis shim
	(globalThis as any).WebSocketPair = StubWebSocketPair;
});
afterAll(() => {
	// biome-ignore lint/suspicious/noExplicitAny: globalThis shim
	(globalThis as any).WebSocketPair = priorWebSocketPair;
});

// `cloudflare:workers` is not resolvable in Bun. Mock it with a barebones
// DurableObject base that records `ctx`/`env` so the AttachRelay constructor runs.
mock.module('cloudflare:workers', () => ({
	DurableObject: class {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
	WorkerEntrypoint: class {},
}));

// ────────────────────────────────────────────────────────────────────────────
// DRIVER
// ────────────────────────────────────────────────────────────────────────────

const HOST_ID = 'host-mac';
const PRINCIPAL_A = 'user-a';
const PRINCIPAL_B = 'user-b';

/**
 * A fake `DurableObjectNamespace` of real `AttachRelay` instances, one per DO
 * name (the coordinator's in-memory state per pair). `idFromName` carries the
 * name; `get(id)` memoizes an instance and forwards `fetch`.
 */
async function makeRelay() {
	// Dynamic import so the cloudflare:workers mock is in place first.
	const { AttachRelay, createDurableObjectAttachRelay } = await import(
		'./cloudflare-do.js'
	);
	const instances = new Map<string, InstanceType<typeof AttachRelay>>();
	const namespace = {
		idFromName: (name: string) => ({ name }),
		get: (id: { name: string }) => ({
			fetch: (req: Request) => {
				let inst = instances.get(id.name);
				if (!inst) {
					// biome-ignore lint/suspicious/noExplicitAny: stub ctx/env
					inst = new AttachRelay({} as any, {} as any);
					instances.set(id.name, inst);
				}
				return inst.fetch(req);
			},
		}),
	};
	// biome-ignore lint/suspicious/noExplicitAny: fake namespace
	const handler = createDurableObjectAttachRelay(namespace as any);
	return { handler, instances };
}

/**
 * An upgrade descriptor as the mount produces it: `principalId` is the
 * server-resolved (authoritative) value, while the connect-query `principalId`
 * is a bogus client claim, so a passing pairing test also proves the registry
 * stamps the resolved principal over the query.
 */
function upgrade(params: {
	role: 'host' | 'client';
	principalId: string;
	hostId: string;
	deviceId?: string;
	attachId?: string;
}) {
	const url = new URL('https://cloud.example/attach');
	url.searchParams.set('role', params.role);
	url.searchParams.set('principalId', 'query-claims-someone-else');
	url.searchParams.set('hostId', params.hostId);
	if (params.deviceId) url.searchParams.set('deviceId', params.deviceId);
	if (params.attachId) url.searchParams.set('attachId', params.attachId);
	const request = new Request(url, {
		headers: {
			Upgrade: 'websocket',
			'sec-websocket-protocol': 'epicenter, bearer.tok',
		},
	});
	return {
		request,
		principalId: params.principalId,
		role: params.role,
		hostId: params.hostId,
		deviceId: params.deviceId,
		attachId: params.attachId,
	};
}

/** The stub pair minted for the Nth accepted upgrade, or throw if none. */
function pairAt(index: number): {
	client: StubWebSocket;
	server: StubWebSocket;
} {
	const pair = webSocketPairs[index];
	if (!pair) throw new Error(`no web socket pair at index ${index}`);
	return pair;
}

function frameMatches(frame: string, fields: Record<string, unknown>): boolean {
	let value: unknown;
	try {
		value = JSON.parse(frame);
	} catch {
		return false;
	}
	if (value === null || typeof value !== 'object') return false;
	const record = value as Record<string, unknown>;
	return Object.entries(fields).every(([key, want]) => record[key] === want);
}

describe('AttachRelay Durable Object backend', () => {
	test('host and client of one pair share a DO and exchange live bytes', async () => {
		webSocketPairs.length = 0;
		const { handler } = await makeRelay();

		const hostResponse = await handler.handleUpgrade(
			upgrade({ role: 'host', principalId: PRINCIPAL_A, hostId: HOST_ID }),
		);
		expect(hostResponse.status).toBe(101);
		const host = pairAt(0);
		expect(host.server.accepted).toBe(true);

		await handler.handleUpgrade(
			upgrade({
				role: 'client',
				principalId: PRINCIPAL_A,
				hostId: HOST_ID,
				deviceId: 'phone',
				attachId: 'attach-1',
			}),
		);
		const phone = pairAt(1);

		// The host saw the phone attach: the coordinator forwarded a lifecycle event
		// onto the host's server socket. This only fires if both sockets landed on
		// ONE DO, which in turn requires the registry to have stamped PRINCIPAL_A
		// (the query claimed someone else).
		expect(
			host.server.sent.some((f) =>
				frameMatches(f, {
					deviceId: 'phone',
					attachId: 'attach-1',
					event: 'attach',
				}),
			),
		).toBe(true);

		// Phone -> host: the client's opaque bytes reach the host stamped with its
		// source endpoint.
		phone.client.send('session-command-from-phone');
		expect(
			host.server.sent.some((f) =>
				frameMatches(f, {
					deviceId: 'phone',
					attachId: 'attach-1',
					payload: 'session-command-from-phone',
				}),
			),
		).toBe(true);

		// Host -> phone: the host addresses the one client endpoint; the relay
		// delivers the opaque payload to that socket.
		host.client.send(
			JSON.stringify({
				deviceId: 'phone',
				attachId: 'attach-1',
				payload: 'snapshot-for-phone',
			}),
		);
		expect(phone.server.sent).toContain('snapshot-for-phone');
	});

	test("account B's client cannot reach account A's host: routed to another DO", async () => {
		webSocketPairs.length = 0;
		const { handler } = await makeRelay();

		await handler.handleUpgrade(
			upgrade({ role: 'host', principalId: PRINCIPAL_A, hostId: HOST_ID }),
		);
		const host = pairAt(0);

		// Same hostId, but the server-resolved principal is B: a different DO name,
		// so a different (empty) actor, so no live host to pair with.
		await handler.handleUpgrade(
			upgrade({
				role: 'client',
				principalId: PRINCIPAL_B,
				hostId: HOST_ID,
				deviceId: 'attacker-phone',
				attachId: 'attach-x',
			}),
		);
		const attacker = pairAt(1);

		expect(attacker.server.closes[0]?.code).toBe(RELAY_CLOSE.HOST_NOT_FOUND);
		expect(host.server.sent.some((f) => f.includes('attacker-phone'))).toBe(
			false,
		);
	});

	test('a non-upgrade request is refused, no socket is minted', async () => {
		webSocketPairs.length = 0;
		const { handler } = await makeRelay();
		const request = new Request(
			'https://cloud.example/attach?role=host&principalId=x&hostId=h',
		);
		const response = await handler.handleUpgrade({
			request,
			principalId: PRINCIPAL_A,
			role: 'host',
			hostId: HOST_ID,
			deviceId: undefined,
			attachId: undefined,
		});
		expect(response.status).toBe(405);
		expect(webSocketPairs.length).toBe(0);
	});

	test('a client missing its endpoint ids is a 400, before any DO socket', async () => {
		webSocketPairs.length = 0;
		const { handler } = await makeRelay();
		// role=client but no deviceId/attachId: an incomplete endpoint shape.
		const response = await handler.handleUpgrade(
			upgrade({ role: 'client', principalId: PRINCIPAL_A, hostId: HOST_ID }),
		);
		expect(response.status).toBe(400);
		expect(webSocketPairs.length).toBe(0);
	});
});
