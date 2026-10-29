/**
 * Test support: the property test's world over the real wire. One server
 * behind the Bun dev server on localhost; each device's replica speaks to it
 * through the wire client, every request a real HTTP request and the feed a
 * real WebSocket.
 *
 * Time stays virtual, so a seed replays: the seeded network decides when a
 * request leaves, whether it or its reply is lost, and when the reply or a
 * notification arrives, and the world steps one event at a time. After each
 * event it waits for the real I/O that event started (the request's HTTP
 * exchange, a socket opening, a flush) and, when a commit landed, pings every
 * open socket, so each notification the server sent has arrived (a pong comes
 * after everything sent before it). Notifications that arrived are then taken
 * in device order, so their timing draws are deterministic too.
 *
 * A lost notification closes the socket, as in the memory harness; the
 * device reopens it, and the feed's `head` tells the replica whether it must
 * catch up: resume from the last head, over the wire.
 */
import { openBunSqlite } from '../bun/sqlite.js';
import { serveRepository, socketWithHeaders } from '../bun/serve.js';
import { createMemoryGitStore } from '../server/memory-git.js';
import { type Committed, createServer, type Session } from '../server/server.js';
import { createWireClient, type FeedConnection } from '../wire/client.js';
import { authenticateBearer, type FeedMessage } from '../wire/wire.js';
import { type Device, EPOCH } from './harness.js';
import { createNet } from './net.js';
import type { PropertyWorld, WorldOptions } from './property.test-support.js';
import { createMemoryStore, createReplica, type Reply, type Request } from './replica.js';

export function createWireWorld({ seed = 1, latency = { min: 5, max: 40 }, loss = { up: 0, down: 0 }, streamLoss = 0, stall, timeout = 2_000, trace }: WorldOptions = {}): PropertyWorld {
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
	const served = serveRepository({ server, authenticate: authenticateBearer(session) });
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
	/** A commit landed since the last ping: notifications may be on their way. */
	let landed = false;
	server.subscribe(() => {
		landed = true;
	});
	const delay = () => random.int(latency.min, latency.max) + (links.stall !== undefined && random.chance(links.stall.chance) ? random.int(0, links.stall.ms) : 0);

	type Feed = { socket: FeedConnection; open: boolean; inbox: (FeedMessage | 'closed')[] };
	const devices: { ping(): Promise<void>; drain(): void }[] = [];

	async function quiesce() {
		for (;;) {
			if (io.size > 0) {
				await Promise.all([...io]);
				continue;
			}
			await server.idle();
			if (io.size > 0) continue;
			if (landed) {
				landed = false;
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
		let store = createMemoryStore();
		const make = () => createReplica({ device: name, mode, store, after: net.after, now: net.now, timeout });
		let replica = make();
		let online = true;
		let link: { open: boolean; loseNextDown: boolean; up: (request: Request) => void } | null = null;
		let feed: Feed | null = null;
		let reopening = false;

		function openRequests() {
			const current = {
				open: true,
				loseNextDown: false,
				up(request: Request) {
					if (!current.open || random.chance(links.loss.up)) return;
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
				},
			};
			link = current;
			replica.attach(current.up);
		}

		function openStream() {
			if (!online || feed?.open) return;
			let opened = () => {};
			track(
				new Promise<void>((resolve) => {
					opened = resolve;
				}),
			);
			const current: Feed = {
				open: true,
				inbox: [],
				socket: client.feed({
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
			feed = current;
		}

		/** The stream is gone: closed here at once, and the device hears of it a delay later, then reopens. */
		function lose(current: Feed) {
			current.open = false;
			current.socket.close();
			net.after(random.int(latency.min, latency.max), () => {
				if (feed !== current) return;
				feed = null;
				if (online) reopen();
			});
		}

		function reopen() {
			if (reopening) return;
			reopening = true;
			net.after(random.int(10, 60), () => {
				reopening = false;
				if (!online) return;
				if (link === null) openRequests();
				openStream();
			});
		}

		devices.push({
			ping: () => (feed?.open ? feed.socket.ping() : Promise.resolve()),
			drain() {
				const current = feed;
				if (current === null) return;
				for (const message of current.inbox.splice(0)) {
					if (!current.open) break;
					if (message === 'closed') {
						lose(current);
						break;
					}
					if (message.type === 'head') {
						// Resume from the last head: catch up only when main is not where this device stands.
						if (message.main !== replica.position()) replica.streamOpened();
						continue;
					}
					if (random.chance(links.streamLoss)) {
						lose(current);
						break;
					}
					const { type: _, ...event } = message;
					net.after(delay(), () => {
						if (!current.open) return;
						counts.notifications++;
						trace?.(`${net.now()} ${name} notified ${JSON.stringify(event)}`);
						replica.notify(event);
					});
				}
			},
		});

		openRequests();
		openStream();

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
				if (link !== null) link.open = false;
				link = null;
				if (feed !== null) {
					feed.open = false;
					feed.socket.close();
				}
				feed = null;
				replica.attach(null);
			},
			loseNextReply: () => {
				if (link !== null) link.loseNextDown = true;
			},
			restart() {
				replica.close();
				replica = make();
				if (link !== null) replica.attach(link.up);
			},
			lose() {
				replica.close();
				store = createMemoryStore();
				replica = make();
				if (link !== null) replica.attach(link.up);
			},
			storeBytes: () => store.bytes(),
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
