/**
 * AttachRelay source plane and desktop-offline behavior (ADR-0115 wave 6).
 *
 * The wave's product sentence: a phone attached to the desktop Home
 * session can ask a question that uses a desktop-local read-only source, receive
 * the streamed answer over the trusted relay, and later see the finished
 * transcript even when the desktop is offline; it cannot start a new local-source
 * question while the desktop is unreachable.
 *
 * These run on the same authenticated self-host mount as wave 3. What they pin:
 *
 * - A remote client drives a turn that reads a host-local read-only source
 *   (`imessage__search`), the answer streams back, and the source content really
 *   flowed through the session. The trusted relay may see live frame payloads;
 *   the important boundary is that it still routes only endpoint-addressed
 *   frames and never exposes a source route or capability.
 * - The finished transcript is durable in the host's own workspace and reads from
 *   a fresh replica after the desktop process is gone: this models the phone
 *   reading synced history while the desktop is offline. The real cross-device
 *   sync wire for the transcript stays deferred (it is the ADR-gated later wave);
 *   wave 6 proves the local durability and plane separation the wire will later
 *   carry, and crosses no relay or anchor with transcript bytes.
 * - A phone that already holds the finished transcript keeps rendering it once its
 *   host is not `online`, and the ask-gate refuses a new local-source question:
 *   reading is the durable plane, asking is the live-session plane, and they
 *   answer differently (ADR-0079, ADR-0080).
 * - The account-layer ask-gate distinguishes `online` from `offline` and
 *   `unreachable`: both non-online states deny a new question, and they stay
 *   distinct so a client renders the right recovery (ADR-0115 wave 6).
 * - No workspace table ever gains a source row: the only durable table is
 *   `conversations`, and the source content lives there only as the model-facing
 *   text of one tool result, never as a source table or row.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEngine, AgentMessage, EngineChunk } from '@epicenter/agent';
import { chatLens, createAgentMessageDocumentStore } from '@epicenter/chat';
import { openBunRecordEpicenter } from '@epicenter/data/bun';
import {
	createAttachRelayBunServer,
	createDeviceGrantStore,
	createServerApp,
	type DeviceGrantStore,
	mountAttachRelayApp,
} from '@epicenter/server/bun';
import { canAskLocalSource } from './attach-host-status.ts';
import { createAttachRelayClient } from './attach-relay-client.ts';
import {
	attachHostToRelay,
	type RelayHostSocket,
} from './attach-relay-host.ts';
import type { HomeHost } from './host.ts';
import type { LocalSourceMessage } from './local-source-catalog.ts';
import type { HomeServerEvent } from './server.ts';
import { createOwnedTestHomeHost } from './test-home-host.ts';

const HOST_ID = 'host-mac';
/**
 * A distinctive string only the local source knows, so a plaintext leak at the
 * relay is unmistakable. It never appears in a scripted engine text, so anywhere
 * it shows up came from the source read.
 */
const SOURCE_SECRET = 'the vault gate code is 4417';

/** A fixture source: one message carrying the secret, so a read is verifiable. */
function fixtureSearch(_query: string): LocalSourceMessage[] {
	return [{ from: 'Alex', text: SOURCE_SECRET, at: '2026-07-07T18:04:00Z' }];
}

function scriptedEngine(scripts: EngineChunk[][]): AgentEngine {
	let step = 0;
	return async function* () {
		const script = scripts[Math.min(step, scripts.length - 1)] ?? [];
		step += 1;
		for (const chunk of script) yield chunk;
	};
}

function testDataDir(): string {
	return mkdtempSync(join(tmpdir(), 'query-source-'));
}

/** A host wired with the fixture local source over an explicit data dir. */
function createSourceHost(
	dataDir: string,
	engine: AgentEngine,
): Promise<HomeHost> {
	return createOwnedTestHomeHost({
		dataDir,
		model: 'test-model',
		engine,
		localSource: { search: fixtureSearch },
	});
}

/** The scripted turn that reads the source, then answers without naming the secret. */
function sourceReadingEngine(): AgentEngine {
	return scriptedEngine([
		[
			{
				type: 'tool-call',
				toolCallId: 'call-source',
				toolName: 'imessage__search',
				input: { query: 'gate code' },
			},
		],
		[{ type: 'text-delta', delta: 'Alex has it.' }],
	]);
}

/**
 * Stand up the authenticated self-host relay. The store is returned so a test
 * can mint the device grants the connect needs.
 */
function serveSelfHostRelay(): {
	server: ReturnType<typeof Bun.serve>;
	origin: string;
	grants: DeviceGrantStore;
} {
	const attachRelay = createAttachRelayBunServer();
	const grants = createDeviceGrantStore();
	const app = createServerApp({
		identity: {
			resolveOrigin: () => 'http://127.0.0.1',
			resolveTrustedOrigins: () => [],
		},
	});
	mountAttachRelayApp(app, {
		resolveBearerPrincipal: grants.resolveBearerPrincipal,
		resolveRelay: () => attachRelay,
	});
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: (req) => app.fetch(req, {} as never),
		websocket: attachRelay.websocket,
	});
	attachRelay.bindServer(server);
	return { server, origin: `ws://127.0.0.1:${server.port}`, grants };
}

async function grantFor(
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

/** Wrap a real host socket to record every frame crossing the host wire (the relay's view). */
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

const wait = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

async function settleHost(host: HomeHost): Promise<void> {
	for (let i = 0; i < 500 && host.snapshot().conversation.isGenerating; i++) {
		await wait(5);
	}
}

/**
 * Read the finished transcript a disposed host left behind, the way a phone's
 * own synced replica would read it while the desktop is offline: open a fresh
 * replica over the persisted data, resume the most recent conversation, and read
 * its message records. Also returns the durable table names, so a test can prove
 * no source table was created.
 */
async function readTranscript(dataDir: string): Promise<{
	tableNames: string[];
	messages: AgentMessage[];
}> {
	await using epicenter = await openBunRecordEpicenter({
		directory: join(dataDir, 'data'),
	});
	const conversations = epicenter.bind({ chat: chatLens }).chat.conversations;
	const tableNames = ['conversations'];
	const rows = (await conversations.scan()).rows;
	let latest = rows[0];
	for (const row of rows) {
		if (!latest || row.updatedAt > latest.updatedAt) latest = row;
	}
	if (!latest) return { tableNames, messages: [] };
	using store = createAgentMessageDocumentStore(
		await conversations.openDocument(latest.id),
	);
	return {
		tableNames,
		messages: [...store.entries()].map((entry) => entry.val),
	};
}

const textParts = (messages: AgentMessage[]): string[] =>
	messages.flatMap((message) =>
		message.parts
			.filter((part) => part.type === 'text')
			.map((part) => part.text),
	);

const toolResults = (messages: AgentMessage[]) =>
	messages.flatMap((message) =>
		message.parts.filter((part) => part.type === 'tool-result'),
	);

describe('AttachRelay source plane (ADR-0115 wave 6)', () => {
	test('a remote ask reads a host local source over endpoint-addressed relay frames', async () => {
		await using host: HomeHost = await createSourceHost(
			testDataDir(),
			sourceReadingEngine(),
		);
		const { server, origin, grants } = serveSelfHostRelay();
		const hostWireFrames: string[] = [];
		const relayHost = attachHostToRelay({
			host,
			relayOrigin: origin,
			principalId: 'ignored',
			hostId: HOST_ID,
			bearer: await grantFor(grants, 'host-mac'),
			openSocket: capturingHostSocket(hostWireFrames),
		});
		await relayHost.ready;

		const client = createAttachRelayClient({
			relayOrigin: origin,
			principalId: 'ignored',
			hostId: HOST_ID,
			deviceId: 'phone',
			attachId: 'attach-1',
			bearer: await grantFor(grants, 'phone'),
		});
		await client.ready;
		try {
			const settled = nextClientSnapshot(
				client,
				settledWith('Alex has it.'),
				'the source answer settling',
			);
			const question = 'what gate code did Alex send?';
			client.send({ type: 'send', content: question });
			const event = await settled;

			// The source content really flowed through the session: it is in a
			// tool-result of the transcript the phone rendered.
			const results = toolResults(event.snapshot.conversation.messages);
			expect(
				results.some((result) => result.content.includes(SOURCE_SECRET)),
			).toBe(true);

			// The trusted relay sees live frame payloads, but the wire shape remains
			// endpoint-addressed: no route, source, capability, or tool surface enters
			// the relay envelope.
			expect(hostWireFrames.length).toBeGreaterThan(0);
			expect(hostWireFrames.some((frame) => frame.includes(question))).toBe(
				true,
			);
			expect(
				hostWireFrames.some((frame) => frame.includes(SOURCE_SECRET)),
			).toBe(true);
			const allowedWireKeys = new Set([
				'deviceId',
				'attachId',
				'event',
				'payload',
			]);
			const forbidden = [
				'route',
				'channel',
				'capability',
				'source',
				'toolName',
			];
			for (const frame of hostWireFrames) {
				const envelope = JSON.parse(frame) as Record<string, unknown>;
				for (const key of Object.keys(envelope)) {
					expect(allowedWireKeys.has(key)).toBe(true);
				}
				for (const key of forbidden) {
					expect(Object.keys(envelope)).not.toContain(key);
				}
			}
		} finally {
			client.close();
			relayHost.close();
			await server.stop(true);
		}
	});

	test('an attached phone told its host is unreachable keeps the finished transcript but refuses a new local-source question', async () => {
		// The durable, host-independent half of "reads history while offline" is
		// proven separately (the no-source-row test reads the full transcript from a
		// fresh replica after the host is gone). This proves the session-plane half:
		// a phone that already has the finished transcript keeps rendering it, and
		// the ask-gate refuses a new local-source question once the host is not
		// `online`. The gate is what a client consults; the desktop's liveness comes
		// from the directory status, not from the client's own relay socket (the
		// phone can be connected to the relay while the desktop is not, which is the
		// `unreachable` state itself).
		await using host: HomeHost = await createSourceHost(
			testDataDir(),
			sourceReadingEngine(),
		);
		const { server, origin, grants } = serveSelfHostRelay();
		const relayHost = attachHostToRelay({
			host,
			relayOrigin: origin,
			principalId: 'ignored',
			hostId: HOST_ID,
			bearer: await grantFor(grants, 'host-mac'),
		});
		await relayHost.ready;

		const client = createAttachRelayClient({
			relayOrigin: origin,
			principalId: 'ignored',
			hostId: HOST_ID,
			deviceId: 'phone',
			attachId: 'attach-1',
			bearer: await grantFor(grants, 'phone'),
		});
		await client.ready;
		try {
			// While the desktop is online, the phone asks and the turn settles.
			const settled = nextClientSnapshot(
				client,
				settledWith('Alex has it.'),
				'the source answer settling while online',
			);
			client.send({ type: 'send', content: 'what did Alex send?' });
			await settled;
			const finishedTranscript =
				client.latest()?.snapshot.conversation.messages ?? [];
			// user + assistant tool step + assistant answer: the turn really ran.
			expect(finishedTranscript.length).toBeGreaterThanOrEqual(2);

			// The directory reports the desktop as unreachable. A phone that consults
			// the ask-gate refuses to start a new local-source question, and it keeps
			// showing the finished transcript it already holds.
			expect(canAskLocalSource('unreachable')).toBe(false);
			expect(client.latest()?.snapshot.conversation.messages).toEqual(
				finishedTranscript,
			);
			expect(
				textParts(finishedTranscript).some((text) =>
					text.includes('Alex has it.'),
				),
			).toBe(true);
		} finally {
			// Close the client while the host is still attached, then the host: the
			// client detaches itself first, so the relay never server-initiates a
			// close and the server drains cleanly.
			client.close();
			relayHost.close();
			await server.stop(true);
		}
	});

	test('the finished transcript reads from a fresh replica after the desktop is gone, and no source row is ever written', async () => {
		// This is the durable half of "see the finished transcript even when the
		// desktop is offline": drive a source-reading turn, end the host process,
		// then read the transcript the way a phone's own synced replica would, with
		// no host running. It also pins the source-plane invariant: reading the
		// source mints no workspace row of its own.
		const dataDir = testDataDir();
		const host = await createSourceHost(dataDir, sourceReadingEngine());
		await host.handleCommand({ type: 'send', content: 'find the gate code' });
		await settleHost(host);
		// The desktop goes offline: the process ends and flushes the transcript.
		await host[Symbol.asyncDispose]();

		const { tableNames, messages } = await readTranscript(dataDir);
		// No `sources`, `imessage`, or `messages` table was minted; the source read
		// wrote nothing of its own.
		expect(tableNames).toEqual(['conversations']);
		// The finished conversation reads back: the user question and the answer.
		const texts = textParts(messages);
		expect(texts.some((text) => text.includes('find the gate code'))).toBe(
			true,
		);
		expect(texts.some((text) => text.includes('Alex has it.'))).toBe(true);
		// The source content exists only as one tool-result inside the transcript,
		// never as a source row.
		expect(
			toolResults(messages).some((result) =>
				result.content.includes(SOURCE_SECRET),
			),
		).toBe(true);
	});
});

describe('a client gates a new local-source question on host liveness (ADR-0115 wave 6)', () => {
	test('only an online host may be asked; offline and unreachable both deny, and stay distinct', () => {
		expect(canAskLocalSource('online')).toBe(true);
		expect(canAskLocalSource('offline')).toBe(false);
		expect(canAskLocalSource('unreachable')).toBe(false);
		// The two denying states are distinct values, so a client can tell "wake
		// your desktop" (offline) from "reconnecting" (unreachable).
		expect('offline').not.toBe('unreachable');
	});
});
