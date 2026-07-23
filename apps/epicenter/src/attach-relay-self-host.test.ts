/**
 * AttachRelay proof (ADR-0115 wave 3): authenticated attach behind per-device
 * grants.
 *
 * The relay is served the way a self-hosted instance serves it: mounted on
 * `createServerApp`, sharing one `Bun.serve` with the rooms backend through the
 * merged websocket handler. Wave 3 splits the single operator token into two
 * credentials on the attach surface:
 * - an attach CONNECT carries a per-device grant (`mountAttachRelayApp` closes
 *   over the grant store's resolver), and the mount stamps the instance principal
 *   server-side;
 * - the operator token administers the device allowlist through `/attach/grants`
 *   (`mountAttachGrantsApp`): it mints a grant per device and revokes one to cut a
 *   device off. There is no fallback path where one credential does both.
 *
 * What this pins:
 * - a host and a client, each carrying their own device grant, attach and share
 *   one session, proving "just works after pairing" against a self-host URL;
 * - two clients share one host session, and either can approve a mutation the
 *   other's turn raised (the host fans one session to every endpoint);
 * - an unpaired device (a never-minted grant) cannot attach, and a revoked device
 *   is dead on its next connect, without touching the sync plane;
 * - the admin surface is gated by the operator token, not a grant, and its
 *   `/attach/grants` routing does not collide with the `/attach` upgrade;
 * - `principalId` is resolved SERVER-SIDE: two ends that put DIFFERENT
 *   `principalId`s in their query still pair, because the mount ignores the query
 *   and stamps the one instance principal every grant resolves to;
 * - the authenticated host wire carries only the endpoint envelope, never a
 *   route, channel, or capability name (ADR-0115 clause 1).
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEngine, EngineChunk } from '@epicenter/agent';
import {
	createAttachRelayBunServer,
	createBunRooms,
	createDeviceGrantStore,
	createEnvTokenResolver,
	createServerApp,
	type DeviceGrantStore,
	mergeBunWebSocketHandlers,
	mountAttachGrantsApp,
	mountAttachRelayApp,
	mountHostDirectoryApp,
	requireBearerPrincipal,
} from '@epicenter/server/bun';
import { createAttachRelayClient } from './attach-relay-client.ts';
import {
	attachHostToRelay,
	type RelayHostSocket,
} from './attach-relay-host.ts';
import type { HomeHost } from './host.ts';
import type { HomeServerEvent } from './server.ts';
import { createOwnedTestHomeHost } from './test-home-host.ts';

/** A strong-enough operator bearer for the admin surface's constant-time compare. */
const OPERATOR_TOKEN = 'self-host-instance-token-0123456789abcdef';
const HOST_ID = 'host-mac';

function scriptedEngine(scripts: EngineChunk[][]): AgentEngine {
	let step = 0;
	return async function* () {
		const script = scripts[Math.min(step, scripts.length - 1)] ?? [];
		step += 1;
		for (const chunk of script) yield chunk;
	};
}

function testDataDir(): string {
	return mkdtempSync(join(tmpdir(), 'query-relay-selfhost-'));
}

function createTestHost(engine: AgentEngine) {
	return createOwnedTestHomeHost({
		dataDir: testDataDir(),
		model: 'test-model',
		engine,
	});
}

/**
 * Stand up the authenticated self-host relay: `createServerApp` +
 * `mountAttachRelayApp` (attach connects gated by device grants) +
 * `mountAttachGrantsApp` (the admin surface gated by the operator token), sharing
 * one `Bun.serve` with the rooms backend. This is the exact production wiring of
 * `apps/self-host/server.ts`, minus inference/blobs. Returns the grant store so a
 * test can mint and revoke directly, plus the HTTP origin for the admin surface.
 */
function serveSelfHostRelay(operatorToken: string): {
	server: ReturnType<typeof Bun.serve>;
	origin: string;
	httpOrigin: string;
	grants: DeviceGrantStore;
} {
	const bunRooms = createBunRooms({ dir: testDataDir() });
	const attachRelay = createAttachRelayBunServer();
	const grants = createDeviceGrantStore();
	const app = createServerApp({
		resolveRooms: () => bunRooms.rooms,
		identity: {
			resolveOrigin: () => 'http://127.0.0.1',
			resolveTrustedOrigins: () => [],
		},
	});
	mountAttachRelayApp(app, {
		resolveBearerPrincipal: grants.resolveBearerPrincipal,
		resolveRelay: () => attachRelay,
	});
	mountAttachGrantsApp(app, {
		auth: requireBearerPrincipal(createEnvTokenResolver(operatorToken)),
		grants,
	});
	// The client's host-discovery read, gated by a device grant (as on self-host).
	mountHostDirectoryApp(app, {
		resolveBearerPrincipal: grants.resolveBearerPrincipal,
		resolveHostDirectory: () => attachRelay.hostDirectory,
	});

	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: (req) => app.fetch(req, {} as never),
		websocket: mergeBunWebSocketHandlers({
			rooms: bunRooms.websocket,
			attach: attachRelay.websocket,
		}),
	});
	bunRooms.bindServer(server);
	attachRelay.bindServer(server);
	return {
		server,
		origin: `ws://127.0.0.1:${server.port}`,
		httpOrigin: `http://127.0.0.1:${server.port}`,
		grants,
	};
}

/** Mint a grant directly on the store and return its secret (the pairing payload). */
async function pairDevice(
	grants: DeviceGrantStore,
	deviceId: string,
): Promise<string> {
	return (await grants.mint({ deviceId })).token;
}

/** Resolve on the first snapshot matching `predicate`, checking the latest first. */
function nextClientSnapshot(
	client: {
		latest(): HomeServerEvent | undefined;
		subscribe(l: (e: HomeServerEvent) => void): () => void;
	},
	predicate: (event: HomeServerEvent) => boolean,
	description: string,
	timeoutMs = 5000,
): Promise<HomeServerEvent> {
	return new Promise((resolve, reject) => {
		let unsubscribe = () => {};
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error(`timed out waiting for ${description}`));
		}, timeoutMs);
		const settle = (event: HomeServerEvent) => {
			if (!predicate(event)) return;
			clearTimeout(timer);
			unsubscribe();
			resolve(event);
		};
		unsubscribe = client.subscribe(settle);
		const current = client.latest();
		if (current) settle(current);
	});
}

/** The turn settled and the last assistant message contains `text`. */
const settledWith =
	(text: string) =>
	(event: HomeServerEvent): boolean => {
		const conversation = event.snapshot.conversation;
		const last = conversation.messages.at(-1);
		return (
			!conversation.isGenerating &&
			last?.role === 'assistant' &&
			last.parts.some(
				(part) => part.type === 'text' && part.text.includes(text),
			)
		);
	};

/**
 * Open a raw WebSocket and resolve how the handshake settled: `open` if the
 * server upgraded it, `close` if it refused. The auth proof needs no adapter; it
 * only needs to know whether the grant let the socket upgrade.
 */
function handshakeOutcome(
	url: string,
	protocols?: string[],
): Promise<'open' | 'close'> {
	return new Promise((resolve) => {
		const ws = new WebSocket(url, protocols);
		ws.onopen = () => {
			resolve('open');
			ws.close();
		};
		ws.onerror = () => {};
		ws.onclose = () => resolve('close');
	});
}

/** Wrap a real host socket to record every frame crossing the host wire. */
function capturingHostSocket(
	frames: string[],
): (url: string, protocols?: string[]) => RelayHostSocket {
	return (url, protocols) => {
		const ws = new WebSocket(url, protocols);
		const originalSend = ws.send.bind(ws);
		(ws as { send: (data: string) => void }).send = (data: string) => {
			frames.push(data);
			originalSend(data);
		};
		ws.addEventListener('message', (event) => {
			if (typeof event.data === 'string') frames.push(event.data);
		});
		return ws as unknown as RelayHostSocket;
	};
}

/** Attach a client endpoint carrying its own device grant. */
async function attachClient(
	origin: string,
	bearer: string,
	deviceId: string,
	attachId: string,
) {
	const client = createAttachRelayClient({
		relayOrigin: origin,
		principalId: 'ignored-by-server',
		hostId: HOST_ID,
		deviceId,
		attachId,
		bearer,
	});
	await client.ready;
	return client;
}

describe('AttachRelay: attach behind per-device grants', () => {
	test('a host and client, each with a device grant, share one session', async () => {
		await using host: HomeHost = await createTestHost(
			scriptedEngine([
				[{ type: 'text-delta', delta: 'Attached through self-host.' }],
			]),
		);
		const { server, origin, grants } = serveSelfHostRelay(OPERATOR_TOKEN);
		const relayHost = attachHostToRelay({
			host,
			relayOrigin: origin,
			principalId: 'ignored-by-server',
			hostId: HOST_ID,
			bearer: await pairDevice(grants, 'host-mac'),
		});
		await relayHost.ready;

		const client = createAttachRelayClient({
			relayOrigin: origin,
			principalId: 'ignored-by-server',
			hostId: HOST_ID,
			deviceId: 'phone',
			attachId: 'attach-1',
			bearer: await pairDevice(grants, 'phone'),
		});
		await client.ready;
		try {
			const settled = nextClientSnapshot(
				client,
				settledWith('Attached through self-host.'),
				'the client settling',
			);
			client.send({ type: 'send', content: 'hi over self-host' });
			const event = await settled;
			expect(event.snapshot.conversation.messages.map((m) => m.role)).toEqual([
				'user',
				'assistant',
			]);
		} finally {
			client.close();
			relayHost.close();
			await server.stop(true);
		}
	});

	test('the server stamps the instance principal, ignoring the query principalId', async () => {
		await using host: HomeHost = await createTestHost(
			scriptedEngine([[{ type: 'text-delta', delta: 'One partition.' }]]),
		);
		const { server, origin, grants } = serveSelfHostRelay(OPERATOR_TOKEN);
		// The host and the client put DIFFERENT principalIds in their query. The
		// mount ignores both and stamps the one instance principal every grant
		// resolves to, so they DO pair.
		const relayHost = attachHostToRelay({
			host,
			relayOrigin: origin,
			principalId: 'principal-A',
			hostId: HOST_ID,
			bearer: await pairDevice(grants, 'host-mac'),
		});
		await relayHost.ready;

		const client = createAttachRelayClient({
			relayOrigin: origin,
			principalId: 'principal-B',
			hostId: HOST_ID,
			deviceId: 'phone',
			attachId: 'attach-1',
			bearer: await pairDevice(grants, 'phone'),
		});
		await client.ready;
		try {
			const settled = nextClientSnapshot(
				client,
				settledWith('One partition.'),
				'the client settling across mismatched query principals',
			);
			client.send({ type: 'send', content: 'still one partition' });
			const event = await settled;
			expect(event.snapshot.conversation.messages.map((m) => m.role)).toEqual([
				'user',
				'assistant',
			]);
		} finally {
			client.close();
			relayHost.close();
			await server.stop(true);
		}
	});

	test('an unpaired device is refused, and a revoked device dies on its next connect', async () => {
		const { server, origin, grants } = serveSelfHostRelay(OPERATOR_TOKEN);
		try {
			const hostUrl = `${origin}/attach?role=host&principalId=x&hostId=${HOST_ID}`;
			// A never-minted grant: nothing resolves, so the upgrade never happens.
			expect(
				await handshakeOutcome(hostUrl, ['epicenter', 'bearer.never-minted']),
			).toBe('close');
			// No grant at all: nothing to extract, so 401 and no upgrade.
			expect(await handshakeOutcome(hostUrl, ['epicenter'])).toBe('close');

			// A paired device DOES upgrade.
			const grant = await grants.mint({ deviceId: 'phone' });
			expect(
				await handshakeOutcome(hostUrl, ['epicenter', `bearer.${grant.token}`]),
			).toBe('open');

			// Revoke it; the same grant is now dead on the next connect, without any
			// change to the sync plane (rooms never consulted the grant store).
			expect(grants.revoke(grant.id)).toBe(true);
			expect(
				await handshakeOutcome(hostUrl, ['epicenter', `bearer.${grant.token}`]),
			).toBe('close');
		} finally {
			await server.stop(true);
		}
	});

	test('the operator token mints and revokes over the admin surface, and a grant cannot self-administer', async () => {
		const { server, origin, httpOrigin } = serveSelfHostRelay(OPERATOR_TOKEN);
		try {
			const mint = (token: string) =>
				fetch(`${httpOrigin}/attach/grants`, {
					method: 'POST',
					headers: {
						authorization: `Bearer ${token}`,
						'content-type': 'application/json',
					},
					body: JSON.stringify({ deviceId: 'phone', label: 'Phone' }),
				});

			// A wrong operator token cannot mint.
			expect((await mint('wrong-operator-token')).status).toBe(401);

			// The operator mints a grant; the secret comes back once.
			const minted = await mint(OPERATOR_TOKEN);
			expect(minted.status).toBe(201);
			const grant = (await minted.json()) as { id: string; token: string };
			expect(typeof grant.token).toBe('string');

			const hostUrl = `${origin}/attach?role=host&principalId=x&hostId=${HOST_ID}`;
			// The minted grant attaches; a device grant cannot reach the admin surface.
			expect(
				await handshakeOutcome(hostUrl, ['epicenter', `bearer.${grant.token}`]),
			).toBe('open');
			expect(
				(
					await fetch(`${httpOrigin}/attach/grants`, {
						method: 'GET',
						headers: { authorization: `Bearer ${grant.token}` },
					})
				).status,
			).toBe(401);

			// The operator revokes it; the grant is dead on the next connect.
			const revoked = await fetch(`${httpOrigin}/attach/grants/${grant.id}`, {
				method: 'DELETE',
				headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
			});
			expect(revoked.status).toBe(204);
			expect(
				await handshakeOutcome(hostUrl, ['epicenter', `bearer.${grant.token}`]),
			).toBe('close');
		} finally {
			await server.stop(true);
		}
	});

	test('the authenticated host wire is still endpoint-addressed, never route-addressed', async () => {
		await using host: HomeHost = await createTestHost(
			scriptedEngine([[{ type: 'text-delta', delta: 'Endpoint only.' }]]),
		);
		const { server, origin, grants } = serveSelfHostRelay(OPERATOR_TOKEN);
		const hostWireFrames: string[] = [];
		const relayHost = attachHostToRelay({
			host,
			relayOrigin: origin,
			principalId: 'ignored',
			hostId: HOST_ID,
			bearer: await pairDevice(grants, 'host-mac'),
			openSocket: capturingHostSocket(hostWireFrames),
		});
		await relayHost.ready;

		const client = createAttachRelayClient({
			relayOrigin: origin,
			principalId: 'ignored',
			hostId: HOST_ID,
			deviceId: 'phone',
			attachId: 'attach-1',
			bearer: await pairDevice(grants, 'phone'),
		});
		await client.ready;
		try {
			const settled = nextClientSnapshot(
				client,
				settledWith('Endpoint only.'),
				'the client settling',
			);
			client.send({ type: 'send', content: 'hello' });
			await settled;

			expect(hostWireFrames.length).toBeGreaterThan(0);
			const allowedKeys = new Set(['deviceId', 'attachId', 'event', 'payload']);
			const forbidden = [
				'route',
				'channel',
				'capability',
				'name',
				'path',
				'toolName',
			];
			for (const frame of hostWireFrames) {
				const parsed = JSON.parse(frame) as Record<string, unknown>;
				for (const key of Object.keys(parsed)) {
					expect(allowedKeys.has(key)).toBe(true);
				}
				for (const key of forbidden) {
					expect(Object.keys(parsed)).not.toContain(key);
				}
			}
		} finally {
			client.close();
			relayHost.close();
			await server.stop(true);
		}
	});

	test('a turn one client drives settles for both attached clients', async () => {
		await using host: HomeHost = await createTestHost(
			scriptedEngine([
				[{ type: 'text-delta', delta: 'Shared over the relay.' }],
			]),
		);
		const { server, origin, grants } = serveSelfHostRelay(OPERATOR_TOKEN);
		const relayHost = attachHostToRelay({
			host,
			relayOrigin: origin,
			principalId: 'ignored-by-server',
			hostId: HOST_ID,
			bearer: await pairDevice(grants, 'host-mac'),
		});
		await relayHost.ready;

		const phone = await attachClient(
			origin,
			await pairDevice(grants, 'phone'),
			'phone',
			'attach-1',
		);
		const cli = await attachClient(
			origin,
			await pairDevice(grants, 'cli'),
			'cli',
			'attach-2',
		);
		try {
			const phoneSettled = nextClientSnapshot(
				phone,
				settledWith('Shared over the relay.'),
				'the phone settling',
			);
			const cliSettled = nextClientSnapshot(
				cli,
				settledWith('Shared over the relay.'),
				'the cli settling',
			);

			// The CLI drives; the phone, which sent nothing, sees the same turn.
			cli.send({ type: 'send', content: 'hi from the cli' });

			const [phoneEvent, cliEvent] = await Promise.all([
				phoneSettled,
				cliSettled,
			]);
			expect(phoneEvent.snapshot.conversation.messages).toEqual(
				cliEvent.snapshot.conversation.messages,
			);
			expect(
				phoneEvent.snapshot.conversation.messages.map((m) => m.role),
			).toEqual(['user', 'assistant']);
		} finally {
			phone.close();
			cli.close();
			relayHost.close();
			await server.stop(true);
		}
	});

	test('either client can approve a mutation the other client raised', async () => {
		await using host: HomeHost = await createTestHost(
			scriptedEngine([
				[
					{
						type: 'tool-call',
						toolCallId: 'call-approve',
						toolName: 'honeycrisp__folders_create',
						input: { name: 'Approve over the relay' },
					},
				],
				[{ type: 'text-delta', delta: 'Created over the relay.' }],
			]),
		);
		const { server, origin, grants } = serveSelfHostRelay(OPERATOR_TOKEN);
		const relayHost = attachHostToRelay({
			host,
			relayOrigin: origin,
			principalId: 'ignored-by-server',
			hostId: HOST_ID,
			bearer: await pairDevice(grants, 'host-mac'),
		});
		await relayHost.ready;

		const phone = await attachClient(
			origin,
			await pairDevice(grants, 'phone'),
			'phone',
			'attach-1',
		);
		const cli = await attachClient(
			origin,
			await pairDevice(grants, 'cli'),
			'cli',
			'attach-2',
		);
		try {
			const phonePending = nextClientSnapshot(
				phone,
				(event) => event.snapshot.pendingApprovals.length === 1,
				'the phone seeing the approval',
			);
			const cliPending = nextClientSnapshot(
				cli,
				(event) => event.snapshot.pendingApprovals.length === 1,
				'the cli seeing the approval',
			);

			// The CLI drives a turn that raises a mutation approval.
			cli.send({ type: 'send', content: 'create a folder' });

			const [phonePendingEvent] = await Promise.all([phonePending, cliPending]);
			const approval = phonePendingEvent.snapshot.pendingApprovals[0];
			if (!approval) throw new Error('expected a pending approval');
			expect(approval.toolName).toBe('honeycrisp__folders_create');

			// The PHONE approves the CLI's turn: either endpoint drives the one session.
			const phoneSettled = nextClientSnapshot(
				phone,
				settledWith('Created over the relay.'),
				'the phone settling after approval',
			);
			const cliSettled = nextClientSnapshot(
				cli,
				settledWith('Created over the relay.'),
				'the cli settling after approval',
			);
			phone.send({ type: 'approve', requestId: approval.id, approved: true });

			const [phoneEvent, cliEvent] = await Promise.all([
				phoneSettled,
				cliSettled,
			]);
			expect(phoneEvent.snapshot.pendingApprovals).toEqual([]);
			expect(cliEvent.snapshot.pendingApprovals).toEqual([]);
			expect(cliEvent.snapshot.conversation.error).toBeNull();
		} finally {
			phone.close();
			cli.close();
			relayHost.close();
			await server.stop(true);
		}
	});

	test('a paired client discovers the host over GET /attach/hosts, online then offline', async () => {
		await using host: HomeHost = await createTestHost(
			scriptedEngine([[{ type: 'text-delta', delta: 'Discoverable.' }]]),
		);
		const { server, origin, httpOrigin, grants } =
			serveSelfHostRelay(OPERATOR_TOKEN);
		const phoneBearer = await pairDevice(grants, 'phone');
		const listHosts = async () => {
			const response = await fetch(`${httpOrigin}/attach/hosts`, {
				headers: { authorization: `Bearer ${phoneBearer}` },
			});
			expect(response.status).toBe(200);
			return (await response.json()) as {
				hosts: { hostId: string; label: string; status: string }[];
			};
		};

		try {
			// Before any host connects, the directory is empty.
			expect((await listHosts()).hosts).toEqual([]);

			const relayHost = attachHostToRelay({
				host,
				relayOrigin: origin,
				principalId: 'ignored-by-server',
				hostId: HOST_ID,
				label: "Braden's Mac",
				bearer: await pairDevice(grants, 'host-mac'),
			});
			await relayHost.ready;

			// The phone discovers exactly the closed entry: id, label, live status.
			expect((await listHosts()).hosts).toEqual([
				{ hostId: HOST_ID, label: "Braden's Mac", status: 'online' },
			]);

			// The desktop goes offline; the host is retained and lists offline, so the
			// phone can still show it (and read synced history), never asking.
			relayHost.close();
			await Bun.sleep(50);
			expect((await listHosts()).hosts).toEqual([
				{ hostId: HOST_ID, label: "Braden's Mac", status: 'offline' },
			]);
		} finally {
			await server.stop(true);
		}
	});

	test('discovery is refused without a device grant', async () => {
		const { server, httpOrigin } = serveSelfHostRelay(OPERATOR_TOKEN);
		try {
			const unauthenticated = await fetch(`${httpOrigin}/attach/hosts`);
			expect(unauthenticated.status).toBe(401);

			// The operator token administers grants but is not itself a device grant,
			// so it does not resolve on the attach-credential-gated discovery read.
			const withOperatorToken = await fetch(`${httpOrigin}/attach/hosts`, {
				headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
			});
			expect(withOperatorToken.status).toBe(401);
		} finally {
			await server.stop(true);
		}
	});
});
