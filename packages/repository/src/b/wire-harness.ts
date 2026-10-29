/**
 * Test support: the property test's world over the real wire. One server
 * behind the Bun dev server on localhost; each device's replica speaks to it
 * through the wire client over real HTTP and a real WebSocket.
 *
 * Two transports. `socket` (a device's own): pushes and catch-ups go up the
 * device's socket, and their answers and every change event come down it,
 * in order; a message lost either way closes the socket, as a dropped
 * connection loses everything in flight; texts by hash are HTTP reads.
 * `http` (a one-shot client's): every request is HTTP, each delayed and
 * lost on its own, and the socket carries only events.
 *
 * Time stays virtual, so a seed replays: the seeded network decides when a
 * message leaves, whether it is lost, and when it arrives, and the world
 * steps one event at a time. After each event it waits for the real I/O
 * that event started (an HTTP exchange, a socket opening, a flush) and,
 * when anything went up a socket or a commit landed, pings every open
 * socket, so everything the server sent has arrived (a pong comes after
 * everything sent before it). What arrived is then taken in device order,
 * so the timing draws are deterministic too.
 *
 * When a socket opens, its `head` names the repository and account, which
 * the replica checks against its binding, and `main`, which tells it
 * whether it must catch up: a device resumes from its last head.
 */
import { openBunSqlite } from '../bun/sqlite.js';
import { serveRepository, socketWithHeaders } from '../bun/serve.js';
import { createMemoryGitStore } from '../server/memory-git.js';
import { type Committed, createServer, type Session } from '../server/server.js';
import { createWireClient, type SocketConnection } from '../wire/client.js';
import { authenticateBearer, type SocketMessage } from '../wire/wire.js';
import { type Device, EPOCH } from './harness.js';
import { unwrap } from 'wellcrafted/result';
import { openReplica, type Reply, type Request } from '../client/replica.js';
import { createNet } from './net.js';
import type { PropertyWorld, WorldOptions } from './property.test-support.js';

export type Transport = 'socket' | 'http';

export function createWireWorld(
	{ seed = 1, latency = { min: 5, max: 40 }, loss = { up: 0, down: 0 }, streamLoss = 0, stall, timeout = 2_000, trace }: WorldOptions = {},
	{ transport = 'socket' }: { transport?: Transport } = {},
): PropertyWorld {
	const net = createNet(seed);
	const { random } = net;
	const links = { loss: { ...loss }, streamLoss, stall };
	const commitHooks: ((committed: Committed) => void)[] = [];
	const requestHooks: ((device: string, request: Request, reply: Reply) => void)[] = [];
	const members = new Set(['mallory']);
	const git = createMemoryGitStore();
	const server = createServer({
		store: openBunSqlite(),
		git,
		clock: () => EPOCH + net.now(),
		timer: net.after,
		onCommit: (committed) => commitHooks.forEach((hook) => hook(committed)),
	});
	const session = (user: string): Session => ({ user, role: members.has(user) ? 'writer' : null });
	const served = serveRepository({ repository: 'test', server, authenticate: authenticateBearer(session) });
	const counts = { push: 0, 'catch-up': 0, fetch: 0, notifications: 0 };

	/** Real I/O in progress: the world waits for all of it before the next event. */
	const io = new Set<Promise<void>>();
	/** A failure of the wire itself (not an answer): the test fails with it. */
	const failures: unknown[] = [];
	const track = (work: Promise<void>) => {
		const tracked = work.catch((cause: unknown) => {
			failures.push(cause);
		});
		io.add(tracked);
		void tracked.then(() => io.delete(tracked));
	};
	/** Something went up a socket, or a commit landed: messages may be on their way down. */
	let stirred = false;
	server.subscribe(() => {
		stirred = true;
	});
	const delay = () => random.int(latency.min, latency.max) + (links.stall !== undefined && random.chance(links.stall.chance) ? random.int(0, links.stall.ms) : 0);
	/** When a message on an ordered connection arrives: its own delay, but never before the one sent before it. */
	const inOrder = (last: { at: number }) => {
		last.at = Math.max(net.now() + delay(), last.at);
		return last.at - net.now();
	};

	type Socket = { connection: SocketConnection; open: boolean; inbox: (SocketMessage | 'closed')[]; up: { at: number }; down: { at: number }; loseNextDown: boolean };
	const devices: { ping(): Promise<void>; drain(): void }[] = [];

	async function quiesce() {
		for (;;) {
			if (io.size > 0) {
				await Promise.all([...io]);
				continue;
			}
			await server.idle();
			if (io.size > 0) continue;
			if (stirred) {
				stirred = false;
				await Promise.all(devices.map((d) => d.ping()));
				continue;
			}
			break;
		}
		if (failures.length > 0) throw failures[0];
		for (const d of devices) d.drain();
	}

	function device(name: string, { mode = 'merge' as 'merge' | 'fast-forward' } = {}): Device {
		members.add(name);
		const authorization = { authorization: `Bearer ${name}` };
		const client = createWireClient({ url: served.url, headers: authorization, openSocket: socketWithHeaders(authorization) });
		let driver = openBunSqlite();
		const make = () =>
			unwrap(openReplica({ driver, binding: { repository: 'test', server: client.url, account: name }, device: name, mode, after: net.after, now: net.now, timeout }));
		let replica = make();
		let online = true;
		/** HTTP requests: each delayed and lost on its own. */
		let link: { open: boolean; loseNextDown: boolean } | null = null;
		let socket: Socket | null = null;
		let reopening = false;
		/** Requests sent up the socket, by request id, for the request hooks. */
		const sent = new Map<number, Request>();

		function overHttp(request: Request) {
			const current = link;
			if (current === null || !current.open || random.chance(links.loss.up)) return;
			net.after(delay(), () => {
				if (!current.open) return;
				counts[request.type]++;
				track(
					client.send(request).then(({ data: reply, error }) => {
						if (error !== null) throw error;
						for (const hook of requestHooks) hook(name, request, reply);
						trace?.(`${net.now()} ${name} ${JSON.stringify(request)}\n    -> ${JSON.stringify(reply)}`);
						const lost = current.loseNextDown || random.chance(links.loss.down);
						current.loseNextDown = false;
						if (!current.open || lost) return;
						net.after(delay(), () => {
							if (!current.open) return;
							trace?.(`${net.now()} ${name} receives reply ${reply.rid}`);
							replica.reply(reply);
						});
					}),
				);
			});
		}

		function overSocket(request: Request) {
			if (request.type === 'fetch') return overHttp(request);
			const current = socket;
			if (current === null || !current.open) return;
			if (random.chance(links.loss.up)) return lose(current);
			net.after(inOrder(current.up), () => {
				if (!current.open) return;
				counts[request.type]++;
				sent.set(request.rid, request);
				current.connection.send(request);
				stirred = true;
			});
		}

		const send = (request: Request) => (transport === 'socket' ? overSocket(request) : overHttp(request));
		const attach = () => replica.attach(send);

		function openLink() {
			link = { open: true, loseNextDown: false };
			if (transport === 'http') attach();
		}

		function openSocket() {
			if (!online || socket?.open) return;
			let opened = () => {};
			track(
				new Promise<void>((resolve) => {
					opened = resolve;
				}),
			);
			const current: Socket = {
				open: true,
				inbox: [],
				up: { at: 0 },
				down: { at: 0 },
				loseNextDown: false,
				connection: client.socket({
					message(message) {
						current.inbox.push(message);
						opened();
					},
					closed() {
						current.inbox.push('closed');
						opened();
					},
				}),
			};
			socket = current;
		}

		/** The socket is gone: closed here at once; the device hears of it a delay later, goes offline on it, and reopens. */
		function lose(current: Socket) {
			current.open = false;
			current.connection.close();
			net.after(random.int(latency.min, latency.max), () => {
				if (socket !== current) return;
				socket = null;
				if (transport === 'socket') replica.attach(null);
				if (online) reopen();
			});
		}

		function reopen() {
			if (reopening) return;
			reopening = true;
			net.after(random.int(10, 60), () => {
				reopening = false;
				if (!online) return;
				if (link === null) openLink();
				openSocket();
			});
		}

		function take(current: Socket, message: SocketMessage) {
			switch (message.type) {
				case 'head': {
					// The binding is checked first; then the device resumes from its last head, catching up only when main is not where it stands.
					const { error } = replica.hello({ server: client.url, repository: message.repository, account: message.user, main: message.main });
					if (error !== null) throw new Error(`${name}: ${error.message}`);
					if (transport === 'socket') attach();
					return true;
				}
				case 'error':
					throw new Error(`${name}: the socket refused a request: ${message.error}`);
				case 'commit': {
					if (random.chance(links.streamLoss)) return false;
					const { type: _, ...event } = message;
					net.after(inOrder(current.down), () => {
						if (!current.open) return;
						counts.notifications++;
						trace?.(`${net.now()} ${name} notified ${JSON.stringify(event)}`);
						replica.notify(event);
					});
					return true;
				}
				case 'answer':
				case 'caught-up': {
					const reply: Reply = message.type === 'answer' ? { type: 'answer', rid: message.rid, answer: message.answer } : message;
					const request = sent.get(message.rid);
					sent.delete(message.rid);
					if (request !== undefined) for (const hook of requestHooks) hook(name, request, reply);
					trace?.(`${net.now()} ${name} ${JSON.stringify(request)}\n    -> ${JSON.stringify(reply)}`);
					const lost = current.loseNextDown || random.chance(links.loss.down);
					current.loseNextDown = false;
					if (lost) return false;
					net.after(inOrder(current.down), () => {
						if (!current.open) return;
						trace?.(`${net.now()} ${name} receives reply ${reply.rid}`);
						replica.reply(reply);
					});
					return true;
				}
				default:
					return message satisfies never;
			}
		}

		devices.push({
			ping: () => (socket?.open ? socket.connection.ping() : Promise.resolve()),
			drain() {
				const current = socket;
				if (current === null) return;
				for (const message of current.inbox.splice(0)) {
					if (!current.open) break;
					// A message lost on the socket, or the socket closing, loses everything after it.
					if (message === 'closed' || !take(current, message)) {
						lose(current);
						break;
					}
				}
			},
		});

		/** Drop every connection. */
		function disconnect() {
			if (link !== null) link.open = false;
			link = null;
			if (socket !== null) {
				socket.open = false;
				socket.connection.close();
			}
			socket = null;
		}

		/**
		 * A new replica gets new connections, as a reloaded page does: replies
		 * to the old one's requests die with its connections, so its request
		 * ids, which the new one may reuse, never answer the new one's.
		 */
		function reconnect() {
			if (!online) return;
			disconnect();
			openLink();
			openSocket();
		}

		openLink();
		openSocket();

		return {
			name,
			get replica() {
				return replica;
			},
			isOnline: () => online,
			setOnline(next: boolean) {
				if (next === online) return;
				online = next;
				if (next) return reopen();
				disconnect();
				replica.attach(null);
			},
			loseNextReply: () => {
				if (transport === 'socket' && socket !== null) socket.loseNextDown = true;
				else if (link !== null) link.loseNextDown = true;
			},
			restart() {
				replica.close();
				replica = make();
				reconnect();
			},
			lose() {
				replica.close();
				driver.close();
				driver = openBunSqlite();
				replica = make();
				reconnect();
			},
		};
	}

	return {
		server,
		git,
		device,
		session,
		flush: () => server.flush(),
		calm() {
			links.loss = { up: 0, down: 0 };
			links.streamLoss = 0;
			delete links.stall;
		},
		onCommit: (hook) => commitHooks.push(hook),
		onRequest: (hook) => requestHooks.push(hook),
		counts: () => ({ ...counts, flushes: server.history().flushes }),
		now: net.now,
		async runFor(ms) {
			const end = net.now() + ms;
			await quiesce();
			while (net.next(end)) await quiesce();
			net.runFor(end - net.now());
		},
		async settle(limit = 1_000_000) {
			for (let n = 0; n < limit; n++) {
				await quiesce();
				if (!net.next()) return true;
			}
			return false;
		},
		close: served.stop,
	};
}
